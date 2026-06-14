import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Opportunity } from './entities/opportunity.entity';
import { CreateOpportunityDto } from './dto/create-opportunity.dto';
import { UpdateOpportunityDto } from './dto/update-opportunity.dto';
import { FindOpportunitiesQueryDto } from './dto/find-opportunities-query.dto';
import {
  OpportunityCategory,
  OpportunitySortBy,
  RabbitMQEventType,
  RabbitMQRoutingKey,
  SortOrder,
} from 'src/enums';
import { User } from 'src/users/entities/user.entity';
import { RabbitMQService } from 'src/rabbitmq/rabbitmq.service';
import { DeleteOpportunityDto } from './dto/delete-opportunity.dto';
import { ApplicationsService } from 'src/applications/applications.service';
import { INotificationRecipient } from 'src/rabbitmq/notification-message.interface';

@Injectable()
export class OpportunitiesService {
  private readonly logger = new Logger(OpportunitiesService.name);
  constructor(
    @InjectRepository(Opportunity)
    private opportunitiesRepository: Repository<Opportunity>,
    @InjectRepository(User)
    private usersRepository: Repository<User>,
    private readonly applicationsService: ApplicationsService, // Inject the ApplicationsService for application-related operations
    private readonly rabbitMQService: RabbitMQService, // Inject the RabbitMQService
  ) {}

  async create(
    createOpportunityDto: CreateOpportunityDto,
  ): Promise<Opportunity> {
    const opportunity =
      this.opportunitiesRepository.create(createOpportunityDto);
    const savedOpportunity =
      await this.opportunitiesRepository.save(opportunity);

    return savedOpportunity;
  }

  async findAll(
    query: FindOpportunitiesQueryDto,
    userId?: number,
  ): Promise<{ data: Opportunity[]; total: number }> {
    const {
      categories: queryCategories,
      search,
      startDate,
      endDate,
      latitude: queryLatitude,
      longitude: queryLongitude,
      radiusKm: queryRadiusKm,
      ngoName,
      page = 1,
      limit = 10,
      sortBy = OpportunitySortBy.CREATED_AT,
      sortOrder = SortOrder.DESC,
    } = query;

    const skip = (page - 1) * limit;

    // Fetch the full user profile if an authenticated user is present
    let fullUserProfile: User | undefined | null;
    if (userId) {
      // Select only necessary fields (categories, latitude, longitude)
      fullUserProfile = await this.usersRepository.findOne({
        where: { id: userId },
        select: ['id', 'categories', 'latitude', 'longitude'],
      });
    }

    const queryBuilder =
      this.opportunitiesRepository.createQueryBuilder('opportunity');
    queryBuilder.leftJoinAndSelect('opportunity.ngo', 'ngo');

    // --- 1. Determine Effective Categories for Filtering ---
    let effectiveCategories: OpportunityCategory[] | undefined;
    if (queryCategories && queryCategories.length > 0) {
      effectiveCategories = queryCategories;
    } else if (
      fullUserProfile &&
      fullUserProfile.categories &&
      fullUserProfile.categories.length > 0
    ) {
      effectiveCategories = fullUserProfile.categories;
    }

    if (effectiveCategories && effectiveCategories.length > 0) {
      // Construct the PostgreSQL array literal string
      // For example, ['education', 'health'] becomes '{"education","health"}'
      const pgArrayLiteral =
        '{' + effectiveCategories.map((c) => `"${c}"`).join(',') + '}';
      console.log('pgArrayLiteral:', pgArrayLiteral);
      // Use the '&&' (overlaps) operator with the explicitly cast string literal
      queryBuilder.andWhere(
        'opportunity.categories && :pgArrayLiteral::opportunities_categories_enum[]', // <--- CORRECTED LINE
        { pgArrayLiteral: pgArrayLiteral }, // Pass the constructed string literal
      );
    }

    // --- 2. Determine Effective Location for Filtering and Sorting ---
    let effectiveLatitude: number | undefined;
    let effectiveLongitude: number | undefined;
    let effectiveRadiusKm: number | undefined; // This will hold the effective radius

    // Priority 1: Location provided in query parameters
    if (
      queryLatitude !== undefined &&
      queryLongitude !== undefined &&
      queryRadiusKm !== undefined
    ) {
      effectiveLatitude = queryLatitude;
      effectiveLongitude = queryLongitude;
      effectiveRadiusKm = queryRadiusKm;
    }
    // Priority 2: User's saved location (for personalized view)
    else if (
      fullUserProfile &&
      fullUserProfile.latitude !== undefined &&
      fullUserProfile.longitude !== undefined
    ) {
      effectiveLatitude = fullUserProfile.latitude;
      effectiveLongitude = fullUserProfile.longitude;
      // Default to 20km if user's location is used and no radius is in query
      effectiveRadiusKm = 20;
    }
    // If no location (neither query nor user profile) then effectiveLocation will remain undefined

    // --- 3. Apply Location-based Filtering and Sorting (Database-side Haversine) ---
    if (
      effectiveLatitude !== undefined &&
      effectiveLongitude !== undefined &&
      effectiveRadiusKm !== undefined
    ) {
      if (effectiveRadiusKm < 0) {
        throw new BadRequestException('Radius must be a non-negative number.');
      }

      // Add distance calculation to SELECT clause to use for ORDER BY
      queryBuilder.addSelect(
        `
        (6371 * acos(
            cos(radians(:effectiveLatitude)) * cos(radians(opportunity.latitude)) *
            cos(radians(opportunity.longitude) - radians(:effectiveLongitude)) +
            sin(radians(:effectiveLatitude)) * sin(radians(opportunity.latitude))
        ))`,
        'distance', // Alias for the calculated distance
      );

      // Apply location filter (distance <= radius)
      queryBuilder.andWhere(
        `
        (6371 * acos(
            cos(radians(:effectiveLatitude)) * cos(radians(opportunity.latitude)) *
            cos(radians(opportunity.longitude) - radians(:effectiveLongitude)) +
            sin(radians(:effectiveLatitude)) * sin(radians(opportunity.latitude))
        )) <= :effectiveRadiusKm
        `,
        {
          effectiveLatitude,
          effectiveLongitude,
          effectiveRadiusKm,
        },
      );

      // Primary sort by distance
      queryBuilder.orderBy('distance', SortOrder.ASC);
      // Secondary sort: by creation date for opportunities at similar distances
      queryBuilder.addOrderBy('opportunity.createdAt', SortOrder.DESC);
    } else {
      // --- Fallback Sorting (if no effective location for filtering/sorting) ---
      if (sortBy === OpportunitySortBy.NGO_NAME) {
        queryBuilder.orderBy(`ngo.name`, sortOrder);
      } else {
        queryBuilder.orderBy(`opportunity.${sortBy}`, sortOrder);
      }
    }

    // --- 4. Apply Other Filters (Search, Date, NGO Name) ---
    if (search) {
      queryBuilder.andWhere(
        '(opportunity.title ILIKE :search OR opportunity.description ILIKE :search)',
        { search: `%${search}%` },
      );
    }

    if (startDate && endDate) {
      queryBuilder.andWhere(
        'opportunity.startDate BETWEEN :startDate AND :endDate',
        {
          startDate: new Date(startDate),
          endDate: new Date(endDate),
        },
      );
    } else if (startDate) {
      queryBuilder.andWhere('opportunity.startDate >= :startDate', {
        startDate: new Date(startDate),
      });
    } else if (endDate) {
      queryBuilder.andWhere('opportunity.endDate <= :endDate', {
        endDate: new Date(endDate),
      });
    }

    if (ngoName) {
      queryBuilder.andWhere('ngo.name ILIKE :ngoName', {
        ngoName: `%${ngoName}%`,
      });
    }

    // Get total count before pagination
    const totalOpportunities = await queryBuilder.getCount();

    // Apply pagination
    queryBuilder.offset(skip).limit(limit);

    // Execute query and get both entities and raw results (for 'distance' field)
    const opportunities = await queryBuilder.getRawAndEntities();

    // Map raw distance to entities for easier access
    const mappedOpportunities = opportunities.entities.map((opp) => {
      const rawData = opportunities.raw.find(
        (r) => r.opportunity_id === opp.id,
      );
      return { ...opp, distance: rawData ? rawData.distance : null };
    });

    return {
      data: mappedOpportunities,
      total: totalOpportunities,
    };
  }

  async findRecent(limit: number = 10): Promise<Opportunity[]> {
    return this.opportunitiesRepository.find({
      relations: ['ngo'],
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  async findOne(id: number): Promise<Opportunity> {
    const opportunity = await this.opportunitiesRepository.findOne({
      where: { id },
      relations: ['ngo'],
    });

    if (!opportunity) {
      throw new NotFoundException(`Opportunity with ID ${id} not found.`);
    }
    return opportunity;
  }

  async update(
    id: number,
    updateOpportunityDto: UpdateOpportunityDto,
    ngoUserId: number,
  ): Promise<Opportunity> {
    const opportunity = await this.opportunitiesRepository.findOne({
      where: { id },
      relations: ['ngo'],
    });

    if (!opportunity) {
      throw new NotFoundException(`Opportunity with ID ${id} not found.`);
    }

    if (opportunity.ngo.id !== ngoUserId) {
      throw new BadRequestException(
        'You are not authorized to update this opportunity.',
      );
    }

    Object.assign(opportunity, updateOpportunityDto);
    const updatedOpportunity =
      await this.opportunitiesRepository.save(opportunity);

    // --- NEW: Fetch all volunteers who applied to this opportunity ---
    try {
      const applications =
        await this.applicationsService.findApplicantsByOpportunityId(
          id,
          updatedOpportunity.ngo.id, // Pass ngoId if needed by findApplicantsByOpportunityId
        );
      this.logger.log(
        `Found ${applications.length} applicants for updated opportunity ID ${id}.`,
      );

      const recipients: INotificationRecipient[] = [];
      for (const app of applications) {
        // Ensure 'volunteer' relation is loaded or app directly has volunteer details
        // Adjust based on your actual `Application` entity and what `findApplicantsByOpportunityId` returns
        if (app) {
          // Assuming application includes a ' relation
          recipients.push({
            user_id: app.id.toString(),
            email_address: app.email,
            device_token: app.fcmToken, // Ensure this field exists
            prefs: {
              receive_email: app.receiveEmailNotifications, // Ensure this field exists
              receive_push: app.receivePushNotifications, // Ensure this field exists
            },
          });
        }
      }

      // --- Publish Notification Event for EACH Recipient ---
      for (const recipient of recipients) {
        await this.rabbitMQService.publishNotification(
          RabbitMQRoutingKey.OPPORTUNITY_UPDATED, // Routing key for updated opportunities
          RabbitMQEventType.OPPORTUNITY_UPDATED, // Event type
          recipient,
          {
            title: `Opportunity Update: ${updatedOpportunity.title}`,
            body: `The opportunity "${updatedOpportunity.title}" you applied for has been updated by ${updatedOpportunity.ngo.name || updatedOpportunity.ngo.email}. Check for new details!`,
            subject: `Important Update: ${updatedOpportunity.title}`,
            deep_link: `/opportunities/details/${updatedOpportunity.id}`,
            opportunity_id: updatedOpportunity.id,
            opportunity_title: updatedOpportunity.title,
            ngo_id: updatedOpportunity.ngo.id,
            ngo_name:
              updatedOpportunity.ngo.name || updatedOpportunity.ngo.email,
            // You might add specific updated fields if `UpdateOpportunityDto` allows you to track changes.
            // For example: updated_fields: Object.keys(updateOpportunityDto).join(', ')
          },
        );
        this.logger.log(
          `Published UPDATE notification for Volunteer ${recipient.user_id} for opportunity ${updatedOpportunity.id}`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Failed to publish UPDATE_OPPORTUNITY event for Opportunity ID ${updatedOpportunity.id}: ${error}`,
        error,
      );
    }

    return updatedOpportunity;
  }

  async remove(
    id: number,
    ngoUserId: number,
    deleteOpportunityDto: DeleteOpportunityDto,
  ): Promise<void> {
    const opportunity = await this.opportunitiesRepository.findOne({
      where: { id },
      relations: ['ngo'],
    });

    if (!opportunity) {
      throw new NotFoundException(`Opportunity with ID ${id} not found.`);
    }

    if (opportunity.ngoId !== ngoUserId) {
      throw new BadRequestException(
        'You are not authorized to delete this opportunity.',
      );
    }
    console.log('opportunity,', opportunity.id);
    // --- Fetch all volunteers who applied to this opportunity ---
    const applications =
      await this.applicationsService.findApplicantsByOpportunityId(
        id,
        opportunity.ngoId,
      );
    console.log('Applications found for opportunity:', applications.length);
    const recipients: INotificationRecipient[] = [];
    for (const app of applications) {
      // Make sure 'volunteer' relation is loaded in the 'applications' array
      // by your findApplicantsByOpportunityId method.
      if (app) {
        // Ensure the volunteer object exists on the application
        recipients.push({
          user_id: app.id.toString(), // CORRECT: Use app.volunteer.id
          email_address: app.email, // CORRECT: Use app.volunteer.email
          device_token: app.fcmToken, // CORRECT: Use app.volunteer.fcmToken
          prefs: {
            // These preferences should ideally come from the volunteer's actual user settings,
            // e.g., app.volunteer.receiveEmailNotifications or app.volunteer.receivePushNotifications
            // For now, defaulting to true as in your example:
            receive_email: app.receiveEmailNotifications,
            receive_push: app.receivePushNotifications,
          },
        });
      } else {
        console.warn(
          `Volunteer data missing for an application. Skipping notification for this application.`,
        );
      }
    }

    for (const recipient of recipients) {
      await this.rabbitMQService.publishNotification(
        RabbitMQRoutingKey.OPPORTUNITY_DELETED,
        RabbitMQEventType.OPPORTUNITY_DELETED,
        recipient,
        {
          title: `Opportunity Canceled: ${opportunity.title}`,
          body: `The opportunity "${opportunity.title}" you applied for has been canceled by ${opportunity.ngo.name || opportunity.ngo.email} for the following reason: ${deleteOpportunityDto.reason}. We apologize for any inconvenience.`, // CORRECT: Using firstName or email for NGO name
          subject: `Opportunity Canceled: ${opportunity.title}`,
          deep_link: `/opportunities/deleted/${opportunity.id}`,
          opportunity_id: opportunity.id,
          opportunity_title: opportunity.title,
          ngo_id: opportunity.ngo.id,
          ngo_name: opportunity.ngo.name || opportunity.ngo.email, // CORRECT: Using firstName or email for NGO name
          deletion_reason: deleteOpportunityDto.reason,
        },
      );
    }

    console.log('Recipients for notification:', recipients);

    // --- Publish Notification Event: Opportunity Deleted ---

    await this.opportunitiesRepository.delete(id);
  }
}

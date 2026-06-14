import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Application } from './entities/application.entity';
import { CreateApplicationDto } from './dto/create-application.dto';
import { Opportunity } from '../opportunities/entities/opportunity.entity';
import { User } from '../users/entities/user.entity';
import {
  ApplicationStatus,
  RabbitMQEventType,
  RabbitMQRoutingKey,
  UserRole,
} from 'src/enums';
import { RabbitMQService } from 'src/rabbitmq/rabbitmq.service';
import {
  INotificationPayload,
  INotificationRecipient,
} from 'src/rabbitmq/notification-message.interface';

@Injectable()
export class ApplicationsService {
  private readonly logger = new Logger(ApplicationsService.name);
  constructor(
    @InjectRepository(Application)
    private applicationsRepository: Repository<Application>,
    @InjectRepository(Opportunity)
    private opportunitiesRepository: Repository<Opportunity>,
    @InjectRepository(User)
    private usersRepository: Repository<User>, // Inject User repository to check volunteer role
    private readonly rabbitMQService: RabbitMQService, // Inject the RabbitMQService
  ) {}

  // Service method to create a new application
  async create(
    createApplicationDto: CreateApplicationDto,
    volunteerId: number,
  ): Promise<Application> {
    const { opportunityId, message } = createApplicationDto;

    // 1. Verify Opportunity exists
    const opportunity = await this.opportunitiesRepository.findOne({
      where: { id: opportunityId },
    });
    if (!opportunity) {
      throw new NotFoundException(
        `Opportunity with ID ${opportunityId} not found.`,
      );
    }

    // 2. Verify User is a Volunteer (Optional but good for robustness)
    const volunteer = await this.usersRepository.findOne({
      where: { id: volunteerId },
    });
    if (!volunteer || volunteer.role !== UserRole.VOLUNTEER) {
      throw new ForbiddenException(
        'Only volunteers can apply for opportunities.',
      );
    }

    // 3. Check if volunteer has already applied to this opportunity
    const existingApplication = await this.applicationsRepository.findOne({
      where: { volunteerId, opportunityId },
    });
    if (existingApplication) {
      throw new BadRequestException(
        'You have already applied for this opportunity.',
      );
    }

    // Create the new application
    const newApplication = this.applicationsRepository.create({
      volunteerId,
      opportunityId,
      message,
      status: ApplicationStatus.PENDING, // Default status
    });

    const savedApplication =
      await this.applicationsRepository.save(newApplication);

    // --- Publish Notification Event: New Application ---
    try {
      const volunteer = await this.usersRepository.findOne({
        where: { id: volunteerId },
      });
      const opportunity = await this.opportunitiesRepository.findOne({
        where: { id: createApplicationDto.opportunityId },
        relations: ['ngo'], // Assuming opportunity has a relation to NGO
      });

      if (volunteer && opportunity && opportunity.ngo) {
        const ngoData = opportunity.ngo; // Get NGO data from the opportunity
        const ngoRecipient: INotificationRecipient = {
          user_id: opportunity.ngoId.toString(), // Convert ID to string for consistency with Go
          email_address: ngoData.email,
          device_token: ngoData.fcmToken,
          prefs: {
            receive_email: ngoData.receiveEmailNotifications,
            receive_push: ngoData.receivePushNotifications,
          },
        };

        const notificationPayload: INotificationPayload = {
          title: `New Application for ${opportunity.title}`,
          body: `Volunteer ${volunteer.name} has applied for your opportunity.`,
          subject: `New Application: ${volunteer.name} for ${opportunity.title}`,
          deep_link: `/ngo/opportunities/${opportunity.id}/applications/${savedApplication.id}`,
          application_id: savedApplication.id,
          opportunity_id: opportunity.id,
          volunteer_id: volunteer.id,
          volunteer_name: volunteer.name,
          ngo_id: ngoData.id,
          ngo_name: ngoData.name,
        };

        console.log('ngoRecipient:', ngoRecipient);
        await this.rabbitMQService.publishNotification(
          RabbitMQRoutingKey.APPLICATION_NEW, // Use the enum
          RabbitMQEventType.APPLICATION_NEW, // Use the enum
          ngoRecipient,
          notificationPayload,
        );
      } else {
        this.logger.warn(
          `Could not publish NEW_APPLICATION event: missing related data for Application ID ${savedApplication.id}`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Failed to publish NEW_APPLICATION event for Application ID ${savedApplication.id}: ${error}`,
      );
    }

    return savedApplication;
  }

  // Service method for a volunteer to view their own applications
  async findApplicationsByVolunteer(
    volunteerId: number,
  ): Promise<Application[]> {
    return this.applicationsRepository.find({
      where: { volunteerId },
      relations: ['opportunity', 'opportunity.ngo'], // Load related opportunity and its NGO
      order: { applicationDate: 'DESC' },
    });
  }

  // Service method for an NGO to view applications for their opportunities
  async findApplicationsByOpportunity(
    opportunityId: number,
    ngoId: number,
  ): Promise<Application[]> {
    // 1. Verify Opportunity exists and belongs to the requesting NGO
    const opportunity = await this.opportunitiesRepository.findOne({
      where: { id: opportunityId },
    });
    if (!opportunity) {
      throw new NotFoundException(
        `Opportunity with ID ${opportunityId} not found.`,
      );
    }
    if (opportunity.ngoId !== ngoId) {
      throw new ForbiddenException(
        'You are not authorized to view applications for this opportunity.',
      );
    }

    // 2. Find applications for this opportunity, loading volunteer details
    return this.applicationsRepository.find({
      where: { opportunityId },
      relations: ['volunteer'], // Load related volunteer details
      order: { applicationDate: 'ASC' },
    });
  }

  // Service method for an NGO to update application status
  async updateApplicationStatus(
    applicationId: number,
    newStatus: ApplicationStatus,
    ngoId: number, // NGO making the change
  ): Promise<Application> {
    // 1. Load Application with ALL necessary relations upfront
    const application = await this.applicationsRepository.findOne({
      where: { id: applicationId },
      // Load volunteer, opportunity, and opportunity's NGO
      relations: ['volunteer', 'opportunity', 'opportunity.ngo'],
    });

    if (!application) {
      throw new NotFoundException(
        `Application with ID ${applicationId} not found.`,
      );
    }

    // Verify the NGO owns the opportunity associated with this application
    // Check if application.opportunity exists before accessing its properties
    if (!application.opportunity || application.opportunity.ngoId !== ngoId) {
      throw new ForbiddenException(
        'You are not authorized to update this application.',
      );
    }

    // Prevent changing status from terminal states or to invalid states
    if (
      [
        ApplicationStatus.REJECTED,
        ApplicationStatus.WITHDRAWN,
        ApplicationStatus.COMPLETED,
      ].includes(application.status) &&
      ![ApplicationStatus.COMPLETED].includes(newStatus)
    ) {
      throw new BadRequestException(
        `Cannot change status from ${application.status}.`,
      );
    }

    if (!Object.values(ApplicationStatus).includes(newStatus)) {
      throw new BadRequestException(`Invalid application status: ${newStatus}`);
    }

    const oldStatus = application.status; // Store the old status for event publishing
    application.status = newStatus;
    const updatedApplication =
      await this.applicationsRepository.save(application);

    // --- Publish Notification Event if status changed ---
    if (oldStatus !== updatedApplication.status) {
      try {
        let recipient: INotificationRecipient;
        let payload: INotificationPayload;
        const routingKey: RabbitMQRoutingKey =
          RabbitMQRoutingKey.APPLICATION_STATUS_CHANGED; // This can be default
        let eventType: RabbitMQEventType;

        // Ensure all required related entities are loaded
        if (
          !updatedApplication.volunteer ||
          !updatedApplication.opportunity ||
          !updatedApplication.opportunity.ngo
        ) {
          this.logger.warn(
            `Skipping notification for Application ID ${updatedApplication.id}: missing volunteer, opportunity, or NGO data.`,
          );
          return updatedApplication; // Exit if critical data is missing
        }

        // Determine recipient and payload based on new status
        switch (updatedApplication.status) {
          case ApplicationStatus.ACCEPTED:
          case ApplicationStatus.REJECTED:
          case ApplicationStatus.COMPLETED: {
            // Recipient is the Volunteer
            const volunteer = updatedApplication.volunteer;
            // You'd fetch device tokens here if you have a UserDevice repository
            // const volunteerDevice = await this.userDevicesRepository.findOne({ where: { userId: volunteer.id } });

            recipient = {
              user_id: volunteer.id.toString(),
              email_address: volunteer.email,
              device_token: volunteer.fcmToken, // Replace with volunteerDevice?.fcmToken if fetched
              prefs: {
                receive_email: volunteer.receiveEmailNotifications,
                receive_push: volunteer.receivePushNotifications,
              },
            };

            payload = {
              title: `Application ${updatedApplication.status.toLowerCase()}: ${updatedApplication.opportunity.title}`,
              body: `Your application for "${updatedApplication.opportunity.title}" has been ${updatedApplication.status.toLowerCase()} by ${updatedApplication.opportunity.ngo.name}.`,
              subject: `Update on your application for ${updatedApplication.opportunity.title}`,
              deep_link: `/volunteer/applications/${updatedApplication.id}`,
              application_id: updatedApplication.id,
              old_status: oldStatus,
              new_status: updatedApplication.status,
              opportunity_id: updatedApplication.opportunity.id,
              opportunity_title: updatedApplication.opportunity.title,
              volunteer_id: volunteer.id,
              volunteer_name: volunteer.name,
              ngo_id: updatedApplication.opportunity.ngo.id,
              ngo_name: updatedApplication.opportunity.ngo.name,
            };

            // Set specific event type for Go service to differentiate
            if (updatedApplication.status === ApplicationStatus.ACCEPTED) {
              eventType = RabbitMQEventType.APPLICATION_ACCEPTED;
            } else if (
              updatedApplication.status === ApplicationStatus.REJECTED
            ) {
              eventType = RabbitMQEventType.APPLICATION_REJECTED;
            } else if (
              updatedApplication.status === ApplicationStatus.COMPLETED
            ) {
              eventType = RabbitMQEventType.APPLICATION_COMPLETED;
            } else {
              eventType = RabbitMQEventType.APPLICATION_STATUS_CHANGED;
            }
            break;
          }
          case ApplicationStatus.WITHDRAWN: {
            // Recipient is the NGO
            const ngo = updatedApplication.opportunity.ngo;
            // You'd fetch device tokens here if you have a UserDevice repository
            // const ngoDevice = await this.userDevicesRepository.findOne({ where: { userId: ngo.id } });

            recipient = {
              user_id: ngo.id.toString(),
              email_address: ngo.email,
              device_token: ngo.fcmToken, // Replace with ngoDevice?.fcmToken if fetched
              prefs: {
                receive_email: ngo.receiveEmailNotifications,
                receive_push: ngo.receivePushNotifications,
              },
            };

            payload = {
              title: `Application Withdrawn: ${updatedApplication.opportunity.title}`,
              body: `Volunteer ${updatedApplication.volunteer.name} has withdrawn their application for "${updatedApplication.opportunity.title}".`,
              subject: `Application Withdrawn: ${updatedApplication.volunteer.name} for ${updatedApplication.opportunity.title}`,
              deep_link: `/ngo/opportunities/${updatedApplication.opportunity.id}/applications/${updatedApplication.id}`,
              application_id: updatedApplication.id,
              old_status: oldStatus,
              new_status: updatedApplication.status,
              opportunity_id: updatedApplication.opportunity.id,
              opportunity_title: updatedApplication.opportunity.title,
              volunteer_id: updatedApplication.volunteer.id,
              volunteer_name: updatedApplication.volunteer.name,
              ngo_id: ngo.id,
              ngo_name: ngo.name,
            };
            eventType = RabbitMQEventType.APPLICATION_WITHDRAWN;
            break;
          }

          default: {
            this.logger.warn(
              `No notification logic defined for status: ${updatedApplication.status}`,
            );
            return updatedApplication; // Don't send notification for unhandled statuses
          }
        }

        // Publish the structured notification using the correct method
        console.log('Publishing notification:', {
          routingKey,
          eventType,
          recipient,
          payload,
        });
        await this.rabbitMQService.publishNotification(
          routingKey,
          eventType as RabbitMQEventType, // Cast to enum type
          recipient,
          payload,
        );

        this.logger.log(
          `Application status update notification for ID ${updatedApplication.id} published.`,
        );
      } catch (error) {
        this.logger.error(
          `Failed to publish application status event for Application ID ${updatedApplication.id}: ${error}`,
          error, // Include stack for better debugging
        );
      }
    }

    return updatedApplication;
  }

  // Service method for a volunteer to withdraw their application
  async withdrawApplication(
    applicationId: number,
    volunteerId: number,
  ): Promise<Application> {
    const application = await this.applicationsRepository.findOne({
      where: { id: applicationId },
    });

    if (!application) {
      throw new NotFoundException(
        `Application with ID ${applicationId} not found.`,
      );
    }

    // Verify the volunteer owns this application
    if (application.volunteerId !== volunteerId) {
      throw new ForbiddenException(
        'You are not authorized to withdraw this application.',
      );
    }

    // Only allow withdrawing if status is PENDING or ACCEPTED (if NGO needs to know)
    if (
      application.status === ApplicationStatus.WITHDRAWN ||
      application.status === ApplicationStatus.REJECTED ||
      application.status === ApplicationStatus.COMPLETED
    ) {
      throw new BadRequestException(
        `Cannot withdraw application with status: ${application.status}.`,
      );
    }

    application.status = ApplicationStatus.WITHDRAWN;
    const oldStatus = application.status;
    const updatedApplication =
      await this.applicationsRepository.save(application);

    // --- Publish Notification Event for Withdrawal ---
    try {
      const volunteer = await this.usersRepository.findOne({
        where: { id: volunteerId },
      });
      const opportunity = await this.opportunitiesRepository.findOne({
        where: { id: application.opportunityId },
        relations: ['ngo'], // Load NGO relation
      });

      if (volunteer && opportunity && opportunity.ngo) {
        const ngoData = opportunity.ngo; // Get NGO data from the opportunity
        const ngoRecipient: INotificationRecipient = {
          user_id: ngoData.id.toString(), // Convert ID to string for consistency with Go
          email_address: ngoData.email,
          prefs: {
            receive_email: ngoData.receiveEmailNotifications,
            receive_push: ngoData.receivePushNotifications,
          },
        };

        const notificationPayload: INotificationPayload = {
          title: `Application Withdrawn for ${opportunity.title}`,
          body: `Volunteer ${volunteer.name} has withdrawn their application.`,
          subject: `Application Withdrawn: ${volunteer.name} for ${opportunity.title}`,
          deep_link: `/ngo/opportunities/${opportunity.id}/applications/${updatedApplication.id}`,
          application_id: updatedApplication.id,
          old_status: oldStatus,
          new_status: updatedApplication.status,
          opportunity_id: opportunity.id,
          opportunity_title: opportunity.title,
          volunteer_id: volunteer.id,
          volunteer_name: volunteer.name,
          ngo_id: ngoData.id,
          ngo_name: ngoData.name,
        };

        await this.rabbitMQService.publishNotification(
          RabbitMQRoutingKey.APPLICATION_STATUS_CHANGED, // Use the enum
          RabbitMQEventType.APPLICATION_WITHDRAWN, // Use the enum
          ngoRecipient,
          notificationPayload,
        );
      } else {
        this.logger.warn(
          `Could not publish WITHDRAWAL event for Application ID ${updatedApplication.id}: missing related data.`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Failed to publish WITHDRAWAL event for Application ID ${updatedApplication.id}: ${error}`,
      );
    }

    return updatedApplication;
  }

  async findApplicantsByOpportunityId(
    opportunityId: number,
    ngoUserId: number,
  ): Promise<User[]> {
    // 1. Verify the opportunity exists and belongs to the requesting NGO
    const opportunity = await this.opportunitiesRepository.findOne({
      where: { id: opportunityId },
      relations: ['ngo'], // Eager load the NGO relation
    });

    if (!opportunity) {
      throw new NotFoundException(
        `Opportunity with ID ${opportunityId} not found.`,
      );
    }

    // Ensure the requesting NGO owns this opportunity
    if (opportunity.ngo.id !== ngoUserId) {
      // If the NGO making the request is not the one who posted the opportunity,
      // and they are not an ADMIN, deny access.
      throw new NotFoundException(
        `Opportunity with ID ${opportunityId} not found or you do not have access.`,
      );
    }

    // 2. Find all applications for this opportunity and load the associated volunteer
    const applications = await this.applicationsRepository.find({
      where: { opportunity: { id: opportunityId } }, // Filter by opportunity ID
      relations: ['volunteer'], // Eager load the 'volunteer' (User) relation
    });

    if (applications.length === 0) {
      // No applicants found for this opportunity, which is a valid state
      return [];
    }

    const applicants: User[] = applications.map((app) => app.volunteer);

    return applicants;
  }
}

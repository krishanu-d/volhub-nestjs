// src/users/dto/create-user.dto.ts

import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsEnum,
  IsArray,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { OpportunityCategory, UserRole } from 'src/enums';

export class CreateUserDto {
  @ApiProperty({
    description: 'The email address of the user',
    example: 'newuser@example.com',
  })
  @IsNotEmpty()
  @IsEmail()
  email!: string;

  @ApiProperty({
    description: 'The full name of the user',
    required: false,
    example: 'New Volunteer User',
  })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiProperty({
    description: "URL of the user's profile picture",
    required: false,
    example: 'http://example.com/profile_pic.jpg',
  })
  @IsOptional()
  @IsString()
  picture?: string;

  @ApiProperty({
    description:
      'The Google ID associated with the user (if signed up via Google)',
    required: false,
    example: '123456789012345678901',
  })
  @IsOptional()
  @IsString()
  googleId?: string;

  @ApiProperty({
    description:
      'The Facebook ID associated with the user (if signed up via Facebook)',
    required: false,
    example: '12345678901234567',
  })
  @IsOptional()
  @IsString()
  facebookId?: string;

  @ApiProperty({
    description:
      'The initial role of the user (Volunteer, NGO, or null). Should be null on first creation for OAuth flow.',
    enum: UserRole,
    required: false,
    nullable: true, // Explicitly marks it as nullable in Swagger
    example: null, // Example value to show it can be null
  })
  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole | null;

  @ApiProperty({
    description: 'Firebase Cloud Messaging Device Token',
    example: 'fcm_token_example',
    nullable: true,
    required: false,
  })
  @IsOptional()
  @IsString()
  fcmToken?: string;

  @ApiProperty({
    description:
      'Categories the user is interested in (Volunteer) or focuses on (NGO)',
    type: [String],
    enum: OpportunityCategory,
    example: [OpportunityCategory.EDUCATION, OpportunityCategory.ENVIRONMENT],
    required: false,
    nullable: true,
  })
  @IsOptional()
  @IsArray()
  @IsEnum(OpportunityCategory, { each: true }) // Validates each item in the array against the enum
  categories?: OpportunityCategory[] | null;
}

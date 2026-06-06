// src/rabbitmq/rabbitmq.service.ts

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { connect, Connection, Channel } from 'amqplib';
import { ConfigService } from '@nestjs/config'; // If using ConfigService for URL
import { RabbitMQRoutingKey, RabbitMQEventType } from '../enums'; // Import your enums
import {
  IGenericNotificationMessage,
  INotificationPayload,
  INotificationRecipient,
} from './notification-message.interface';

@Injectable()
export class RabbitMQService implements OnModuleInit {
  private readonly logger = new Logger(RabbitMQService.name);
  private connection: Connection;
  private channel: Channel;
  private readonly exchangeName: string;
  private readonly rabbitMqUrl: string;

  constructor(private configService: ConfigService) {
    this.rabbitMqUrl =
      this.configService.get<string>('RABBITMQ_URL') || 'amqp://localhost:5672';
    this.exchangeName =
      this.configService.get<string>('RABBITMQ_EXCHANGE_NAME') ||
      'notification_exchange';
  }

  async onModuleInit() {
    await this.connect();
  }

  private async connect() {
    try {
      this.connection = await connect(this.rabbitMqUrl);
      this.channel = await this.connection.createChannel();
      await this.channel.assertExchange(this.exchangeName, 'topic', {
        durable: true,
      });
      this.logger.log(
        'Successfully connected to RabbitMQ and asserted exchange!',
      );
    } catch (error) {
      this.logger.error(
        `Failed to connect to RabbitMQ or assert exchange: ${error}`,
      );
      // Consider more robust error handling / reconnection logic here for production
      throw error; // Re-throw to prevent app from starting if connection fails
    }
  }

  // Old publish method (can be kept or refactored to use the new one)
  async publish(routingKey: string, message: any) {
    if (!this.channel) {
      this.logger.error('RabbitMQ channel not available. Message not sent.');
      return;
    }
    try {
      // Ensure message is stringified for buffer
      const buffer = Buffer.from(JSON.stringify(message));
      this.channel.publish(this.exchangeName, routingKey, buffer);
      this.logger.log(
        `Message published to exchange '${this.exchangeName}' with routing key '${routingKey}'`,
      );
    } catch (error) {
      this.logger.error(`Failed to publish message: ${error}`);
    }
  }

  /**
   * Generic function to publish a structured notification message to RabbitMQ.
   * @param routingKey The routing key (from RabbitMQRoutingKey enum).
   * @param eventType The specific notification event type (from RabbitMQEventType enum).
   * @param recipientData Data to construct the recipient part of the payload.
   * @param payloadData Data specific to the notification content.
   */
  async publishNotification(
    routingKey: RabbitMQRoutingKey,
    eventType: RabbitMQEventType,
    recipientData: INotificationRecipient, // Use the interface for consistency
    payloadData: INotificationPayload, // Use the interface for consistency
  ) {
    if (!this.channel) {
      this.logger.error(
        'RabbitMQ channel not available. Notification not sent.',
      );
      return;
    }

    try {
      // Construct the full message object conforming to IGenericNotificationMessage
      const fullMessage: IGenericNotificationMessage = {
        notification_type: eventType,
        recipient: {
          user_id: recipientData.user_id,
          email_address: recipientData.email_address,
          device_token: recipientData.device_token,
          prefs: {
            receive_email: recipientData.prefs.receive_email,
            receive_push: recipientData.prefs.receive_push,
          },
        },
        payload: payloadData, // The flexible payload
      };

      const buffer = Buffer.from(JSON.stringify(fullMessage));
      console.log('Publishing notification:', fullMessage);
      console.log('Routing Key:', routingKey);
      console.log('Exchange Name:', this.exchangeName);
      this.channel.publish(this.exchangeName, routingKey, buffer);
      this.logger.log(
        `Notification '${eventType}' published to '${this.exchangeName}' with routing key '${routingKey}' for recipient ${recipientData.user_id}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to publish notification '${eventType}': ${error}`,
      );
    }
  }
}

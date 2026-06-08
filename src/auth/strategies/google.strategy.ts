import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, Profile, StrategyOptions } from 'passport-google-oauth20';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  constructor(private readonly configService: ConfigService) {
    super({
      clientID: configService.get<string>('GOOGLE_WEB_CLIENT_ID'),
      clientSecret: configService.get<string>('GOOGLE_WEB_CLIENT_SECRET'),
      callbackURL: configService.get<string>('GOOGLE_CALLBACK_URL'),
      scope: ['profile', 'email'],
      passReqToCallback: false as boolean, // No need to pass req anymore
    } as StrategyOptions);
  }

  async validate(
    accessToken: string,
    refreshToken: string,
    profile: Profile,
    done: any,
  ): Promise<any> {
    const { id, name, emails, photos } = profile;

    const user = {
      provider: 'google',
      id,
      email: emails?.[0]?.value,
      name:
        name?.givenName && name?.familyName
          ? `${name.givenName} ${name.familyName}`
          : name?.givenName || name?.familyName || 'No Name',
      picture: photos?.[0]?.value,
    };
    done(null, user);
  }
}

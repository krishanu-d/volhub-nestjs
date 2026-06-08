import { Injectable, UnauthorizedException } from '@nestjs/common';
import { UsersService } from '../users/users.service';
import { ConfigService } from '@nestjs/config';
import { User } from '../users/entities/user.entity';
import { OAuth2Client } from 'google-auth-library';
import { JwtService } from '@nestjs/jwt';

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
  ) {}

  async validateGoogleUser(
    profile: any,
  ): Promise<{ user: User; isNewUser: boolean }> {
    const { email, name, picture } = profile;
    const existingUser = await this.usersService.findUserByEmail(email);

    if (existingUser) {
      return { user: existingUser, isNewUser: false };
    }

    const newUser = await this.usersService.createUser({
      email,
      name,
      picture,
      googleId: profile.id,
    });
    return { user: newUser, isNewUser: true };
  }

  async validateFacebookUser(
    profile: any,
  ): Promise<{ user: User; isNewUser: boolean }> {
    const { email, name } = profile;
    const picture = profile.picture?.data?.url;
    const facebookId = profile.id;

    const existingUser = await this.usersService.findUserByEmail(email);

    if (existingUser) {
      return { user: existingUser, isNewUser: false };
    }

    const newUser = await this.usersService.createUser({
      email,
      name,
      picture,
      facebookId,
    });
    return { user: newUser, isNewUser: true };
  }

  async validateGoogleIdToken(idToken: string): Promise<{
    user: User | null;
    isNewUser: boolean;
    googlePayload?: {
      email: string;
      name: string;
      picture: string;
      googleId: string;
    };
  }> {
    const client = new OAuth2Client(
      this.configService.get('GOOGLE_WEB_CLIENT_ID'),
    );

    const ticket = await client
      .verifyIdToken({
        idToken,
        audience: this.configService.get('GOOGLE_WEB_CLIENT_ID'),
      })
      .catch((err) => {
        console.error('Error verifying Google ID token:', err);
        throw new UnauthorizedException('Invalid Google token');
      });
    console.log('ticket', ticket);

    const payload = ticket.getPayload();
    if (!payload) throw new UnauthorizedException('Invalid Google token');

    const { email, name, picture, sub: googleId } = payload;
    if (!email) throw new UnauthorizedException('Google token has no email');

    const existingUser = await this.usersService.findUserByEmail(email);

    if (existingUser) {
      return { user: existingUser, isNewUser: false };
    }

    // Return the Google payload so the controller can issue a limited JWT
    return {
      user: null,
      isNewUser: true,
      googlePayload: {
        email,
        name: name ?? '',
        picture: picture ?? '',
        googleId,
      },
    };
  }

  generateJwt(payload: object, options?: { expiresIn: string | number }) {
    const jwtOptions = options || { expiresIn: '7d' };
    return this.jwtService.sign(payload, jwtOptions);
  }
}

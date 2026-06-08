import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthGuard } from '@nestjs/passport';
import { UsersService } from 'src/users/users.service';
import { LimitedJwtGuard } from './guards/limited-jwt-auth.guard';
import { IdTokenClient } from 'google-auth-library';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly usersService: UsersService,
  ) {}

  @Get('google')
  @UseGuards(AuthGuard('google'))
  async googleAuth() {}

  @Get('google/callback')
  @UseGuards(AuthGuard('google'))
  async googleAuthRedirect(@Req() req, @Res() res) {
    if (req.user) {
      const { user, isNewUser } = await this.authService.validateGoogleUser(
        req.user,
      );
      const jwt = this.authService.generateJwt({
        sub: user.id,
        email: user.email,
        role: user.role,
      });
      return res.send({ access_token: jwt, isNewUser, user });
    } else {
      return 'Google login failed';
    }
  }

  @Post('google/login')
  async googleLogin(@Body() body: { idToken: string }) {
    try {
      console.log('idtokennn', body.idToken);
      const { user, isNewUser, googlePayload } =
        await this.authService.validateGoogleIdToken(body.idToken);
      console.log('user', user, isNewUser, googlePayload);
      // ── Existing user ──────────────────────────────────────────
      if (!isNewUser && user) {
        const jwt = this.authService.generateJwt({
          sub: user.id,
          email: user.email,
          role: user.role,
          isProfileComplete: user?.isProfileComplete,
        });
        return { access_token: jwt, isNewUser: false, user };
      }

      // ── New user — issue limited JWT, no role yet ──────────────
      // Limited JWT can only hit POST /auth/complete-profile
      const limitedJwt = this.authService.generateJwt(
        {
          email: googlePayload?.email,
          name: googlePayload?.name,
          picture: googlePayload?.picture,
          googleId: googlePayload?.googleId,
          isProfileComplete: false,
        },
        { expiresIn: '1h' },
      );

      return {
        access_token: limitedJwt,
        isNewUser: true,
        user: null,
      };
    } catch (e) {
      throw new UnauthorizedException('Google token verification failed');
    }
  }
}

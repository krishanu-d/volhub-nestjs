import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config/dist/config.service';
import { JwtService } from '@nestjs/jwt/dist/jwt.service';

@Injectable()
export class LimitedJwtGuard implements CanActivate {
  constructor(
    private jwtService: JwtService,
    private configService: ConfigService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const token = request.headers.authorization?.split(' ')[1];

    if (!token) throw new UnauthorizedException();

    try {
      const payload = this.jwtService.verify(token, {
        secret: this.configService.get('JWT_SECRET'),
      });

      // Only allow tokens where profile is NOT complete
      if (payload.isProfileComplete !== false) {
        throw new UnauthorizedException('Not a limited token');
      }

      request.user = payload;
      return true;
    } catch {
      throw new UnauthorizedException();
    }
  }
}

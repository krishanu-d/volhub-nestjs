import { JwtService, JwtSignOptions } from '@nestjs/jwt';

export const generateJwt = (
  jwtService: JwtService,
  payload: object,
  options?: JwtSignOptions,
) => {
  return jwtService.sign(payload, options);
};

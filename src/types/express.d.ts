import { UserRole } from "@prisma/client";

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        email: string;
        role: UserRole;
      };
      /** Set by the json body parser so webhook signatures can be checked. */
      rawBody?: Buffer;
    }
  }
}

export {};

// filepath: c:\\Users\\Veritas\\Desktop\\wavenet\\backend\\src\\types\\express.d.ts
import { Types } from "mongoose";

declare namespace Express {
  export interface Request {
    user?: {
      _id: Types.ObjectId;
      email: string;
      // Add other user properties if needed
    };
  }
}

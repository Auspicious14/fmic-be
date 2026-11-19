import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type UserDocument = User & Document;

@Schema({ timestamps: true })
export class User {
  @Prop({ required: true, unique: true })
  email: string;

  @Prop({ required: true })
  password: string;

  @Prop()
  name: string;

  @Prop()
  shopName: string;

  @Prop({ default: 'admin' })
  role: string;

  /** WhatsApp number linked to this shop, digits only, e.g. 2348031234567. */
  @Prop({ index: { unique: true, sparse: true } })
  whatsappPhone?: string;
}

export const UserSchema = SchemaFactory.createForClass(User);

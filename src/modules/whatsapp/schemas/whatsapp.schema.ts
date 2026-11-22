import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';

/**
 * What the bot heard and is waiting for the trader to confirm (✅/❌).
 * Kept in MongoDB, not memory, because serverless instances don't share
 * memory between requests. Expires after an hour.
 */
@Schema({ timestamps: true, collection: 'whatsapp_pending' })
export class WhatsappPending {
  @Prop({ required: true, unique: true })
  phone: string;

  @Prop({ required: true })
  userId: string;

  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  interpretation: any;

  /** Inbound message id, used to build idempotency keys. */
  @Prop({ required: true })
  sourceMessageId: string;

  @Prop({ default: () => new Date(), expires: 3600 })
  createdAt: Date;
}
export type WhatsappPendingDocument = WhatsappPending & Document;
export const WhatsappPendingSchema = SchemaFactory.createForClass(WhatsappPending);

/**
 * A new number signing up in the chat. Holds the name until the shop name
 * arrives; expires after a day so a half-finished sign-up starts over.
 */
@Schema({ collection: 'whatsapp_signups' })
export class WhatsappSignup {
  @Prop({ required: true, unique: true })
  phone: string;

  @Prop()
  name?: string;

  @Prop({ default: () => new Date(), expires: 60 * 60 * 24 })
  createdAt: Date;
}
export type WhatsappSignupDocument = WhatsappSignup & Document;
export const WhatsappSignupSchema = SchemaFactory.createForClass(WhatsappSignup);

/** Message ids already handled; Meta can deliver the same webhook twice. */
@Schema({ collection: 'whatsapp_seen' })
export class WhatsappSeen {
  @Prop({ required: true, unique: true })
  messageId: string;

  @Prop({ default: () => new Date(), expires: 60 * 60 * 48 })
  createdAt: Date;
}
export type WhatsappSeenDocument = WhatsappSeen & Document;
export const WhatsappSeenSchema = SchemaFactory.createForClass(WhatsappSeen);

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

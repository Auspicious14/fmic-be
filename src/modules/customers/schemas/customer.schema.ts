import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';

export type CustomerDocument = Customer & Document;

@Schema({ timestamps: true })
export class Customer {
  @Prop({ required: true })
  name: string;

  @Prop()
  tag: string; // e.g., "mechanic", "tailor"

  @Prop({ type: [String], default: [] })
  aliases: string[];

  @Prop()
  phone: string;

  @Prop({ default: 0 })
  outstandingBalance: number;

  @Prop()
  lastTransactionDate: Date;

  @Prop({ default: 0 })
  trustScore: number;

  @Prop()
  notes: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true })
  shopOwner: MongooseSchema.Types.ObjectId;
}

export const CustomerSchema = SchemaFactory.createForClass(Customer);

CustomerSchema.index({ name: 'text', tag: 'text', aliases: 'text', phone: 'text' });

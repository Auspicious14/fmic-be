import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';

export type TransactionDocument = Transaction & Document;

export enum TransactionType {
  CREDIT = 'credit',
  PAYMENT = 'payment',
  ADJUSTMENT = 'adjustment',
}

@Schema({ _id: false })
export class TransactionItem {
  @Prop({ required: true })
  productName: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Product' })
  productId: MongooseSchema.Types.ObjectId | String;

  @Prop({ required: true })
  quantity: number;

  @Prop({ required: true })
  unitPriceAtSale: number;

  @Prop({ required: true })
  totalPrice: number;
}

@Schema({ timestamps: true })
export class Transaction {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'Customer',
    required: true,
  })
  customer: MongooseSchema.Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true })
  shopOwner: MongooseSchema.Types.ObjectId;

  @Prop({ type: [TransactionItem], default: [] })
  items: TransactionItem[];

  @Prop({ required: true })
  totalAmount: number;

  @Prop({ required: true, enum: TransactionType })
  type: TransactionType;

  @Prop()
  voiceTranscript: string;

  @Prop({ type: MongooseSchema.Types.Mixed })
  rawExtractionJson: any;

  @Prop()
  deviceId: string;

  @Prop({ unique: true })
  idempotencyKey: string;

  @Prop()
  hashSignature: string;

  @Prop({ default: 'synced' })
  syncStatus: string;
}

export const TransactionSchema = SchemaFactory.createForClass(Transaction);

TransactionSchema.index({ customer: 1, createdAt: -1 });
TransactionSchema.index({ shopOwner: 1, createdAt: -1 });

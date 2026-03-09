import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';

export type ProductDocument = Product & Document;

@Schema({ _id: false })
class PriceHistory {
  @Prop({ required: true })
  unitPrice: number;

  @Prop()
  bulkPrice: number;

  @Prop({ default: Date.now })
  timestamp: Date;
}

@Schema({ timestamps: true })
export class Product {
  @Prop({ required: true })
  name: string;

  @Prop({ required: true })
  currentUnitPrice: number;

  @Prop()
  currentBulkPrice: number;

  @Prop({ type: [PriceHistory], default: [] })
  pricingHistory: PriceHistory[];

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true })
  shopOwner: MongooseSchema.Types.ObjectId;
}

export const ProductSchema = SchemaFactory.createForClass(Product);

ProductSchema.index({ name: 'text' });

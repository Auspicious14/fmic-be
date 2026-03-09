import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Product, ProductDocument } from './schemas/product.schema';
import { CreateProductDto, UpdatePriceDto } from './dto/product.dto';

@Injectable()
export class ProductsService {
  constructor(
    @InjectModel(Product.name) private productModel: Model<ProductDocument>,
  ) {}

  async create(
    createProductDto: CreateProductDto,
    userId: string,
  ): Promise<ProductDocument> {
    const { name, unitPrice, bulkPrice } = createProductDto;
    const initialHistory = {
      unitPrice,
      bulkPrice,
      timestamp: new Date(),
    };

    const product = new this.productModel({
      name,
      currentUnitPrice: unitPrice,
      currentBulkPrice: bulkPrice,
      pricingHistory: [initialHistory],
      shopOwner: userId,
    });

    return product.save();
  }

  async updatePrice(
    id: string,
    updatePriceDto: UpdatePriceDto,
    userId: string,
  ): Promise<ProductDocument> {
    const product = await this.productModel.findOne({
      _id: id as any,
      shopOwner: userId as any,
    });
    if (!product) {
      throw new NotFoundException(`Product with ID ${id} not found`);
    }

    const newHistoryEntry = {
      unitPrice: updatePriceDto.unitPrice,
      bulkPrice: updatePriceDto.bulkPrice || 0,
      timestamp: new Date(),
    };

    product.currentUnitPrice = updatePriceDto.unitPrice;
    if (updatePriceDto.bulkPrice !== undefined) {
      product.currentBulkPrice = updatePriceDto.bulkPrice;
    }
    (product.pricingHistory as any).push(newHistoryEntry);

    return product.save();
  }

  async findAll(userId: string): Promise<ProductDocument[]> {
    return this.productModel.find({ shopOwner: userId as any }).exec();
  }

  async findOne(id: string, userId: string): Promise<ProductDocument> {
    const product = await this.productModel
      .findOne({ _id: id as any, shopOwner: userId as any })
      .exec();
    if (!product) {
      throw new NotFoundException(`Product with ID ${id} not found`);
    }
    return product;
  }

  async search(query: string, userId: string): Promise<ProductDocument[]> {
    return this.productModel
      .find({
        shopOwner: userId as any,
        $text: { $search: query },
      })
      .exec();
  }

  async getPriceHistory(id: string, userId: string) {
    const product = await this.findOne(id, userId);
    return product.pricingHistory;
  }
}

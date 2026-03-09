import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Customer, CustomerDocument } from './schemas/customer.schema';
import { CreateCustomerDto, UpdateCustomerDto } from './dto/customer.dto';

@Injectable()
export class CustomersService {
  constructor(
    @InjectModel(Customer.name) private customerModel: Model<CustomerDocument>,
  ) {}

  async create(
    createCustomerDto: CreateCustomerDto,
    userId: string,
  ): Promise<CustomerDocument> {
    const createdCustomer = new this.customerModel({
      ...createCustomerDto,
      shopOwner: userId,
    });
    return createdCustomer.save();
  }

  async findAll(userId: string): Promise<CustomerDocument[]> {
    return this.customerModel.find({ shopOwner: userId as any }).exec();
  }

  async findOne(id: string, userId: string): Promise<CustomerDocument> {
    const customer = await this.customerModel
      .findOne({ _id: id as any, shopOwner: userId as any })
      .exec();
    if (!customer) {
      throw new NotFoundException(`Customer with ID ${id} not found`);
    }
    return customer;
  }

  async update(
    id: string,
    updateCustomerDto: UpdateCustomerDto,
    userId: string,
  ): Promise<CustomerDocument> {
    const updatedCustomer = await this.customerModel
      .findOneAndUpdate(
        { _id: id as any, shopOwner: userId as any },
        updateCustomerDto,
        { new: true },
      )
      .exec();
    if (!updatedCustomer) {
      throw new NotFoundException(`Customer with ID ${id} not found`);
    }
    return updatedCustomer as CustomerDocument;
  }

  async search(query: string, userId: string): Promise<CustomerDocument[]> {
    return this.customerModel
      .find({
        shopOwner: userId as any,
        $text: { $search: query },
      })
      .exec();
  }

  async updateBalance(id: string, amount: number): Promise<void> {
    await this.customerModel.findByIdAndUpdate(id, {
      $inc: { outstandingBalance: amount },
      lastTransactionDate: new Date(),
    });
  }
}

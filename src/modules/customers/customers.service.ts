import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Customer, CustomerDocument } from './schemas/customer.schema';
import {
  CreateCustomerDto,
  UpdateCustomerDto,
  DeleteCustomerDto,
} from './dto/customer.dto';

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
    return this.customerModel
      .find({ shopOwner: userId as any, isDeleted: { $ne: true } })
      .exec();
  }

  async findOne(id: string, userId: string): Promise<CustomerDocument> {
    const customer = await this.customerModel
      .findOne({
        _id: id as any,
        shopOwner: userId as any,
        isDeleted: { $ne: true },
      })
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
        { _id: id as any, shopOwner: userId as any, isDeleted: { $ne: true } },
        updateCustomerDto,
        { new: true },
      )
      .exec();
    if (!updatedCustomer) {
      throw new NotFoundException(`Customer with ID ${id} not found`);
    }
    return updatedCustomer as CustomerDocument;
  }

  async softDelete(
    id: string,
    userId: string,
    deleteDto?: DeleteCustomerDto,
  ): Promise<{ message: string; customerId: string }> {
    const customer = await this.customerModel
      .findOneAndUpdate(
        { _id: id as any, shopOwner: userId as any, isDeleted: { $ne: true } },
        {
          isDeleted: true,
          deletedAt: new Date(),
          notes: deleteDto?.reason
            ? `[DELETED] ${deleteDto.reason}`
            : '[DELETED] No reason provided',
        },
        { new: true },
      )
      .exec();

    if (!customer) {
      throw new NotFoundException(`Customer with ID ${id} not found`);
    }

    return {
      message: `Customer "${customer.name}" has been deleted successfully`,
      customerId: id,
    };
  }

  async search(query: string, userId: string): Promise<CustomerDocument[]> {
    return this.customerModel
      .find({
        shopOwner: userId as any,
        isDeleted: { $ne: true },
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

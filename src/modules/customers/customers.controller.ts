import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Delete,
  Param,
  UseGuards,
  Query,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { CustomersService } from './customers.service';
import {
  CreateCustomerDto,
  UpdateCustomerDto,
  DeleteCustomerDto,
} from './dto/customer.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { GetUser } from '../../common/decorators/get-user.decorator';

@ApiTags('Customers')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('customers')
export class CustomersController {
  constructor(private readonly customersService: CustomersService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new customer' })
  async create(
    @Body() createCustomerDto: CreateCustomerDto,
    @GetUser() user: any,
  ) {
    return this.customersService.create(createCustomerDto, user.userId);
  }

  @Get()
  @ApiOperation({ summary: 'Get all customers for the shop' })
  async findAll(@GetUser() user: any) {
    return this.customersService.findAll(user.userId);
  }

  @Get('search')
  @ApiOperation({ summary: 'Search customers by name or phone' })
  async search(@Query('q') q: string, @GetUser() user: any) {
    return this.customersService.search(q, user.userId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single customer' })
  async findOne(@Param('id') id: string, @GetUser() user: any) {
    return this.customersService.findOne(id, user.userId);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update customer details' })
  async update(
    @Param('id') id: string,
    @Body() updateCustomerDto: UpdateCustomerDto,
    @GetUser() user: any,
  ) {
    return this.customersService.update(id, updateCustomerDto, user.userId);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Soft-delete a customer (keeps audit trail)' })
  @ApiResponse({ status: 200, description: 'Customer soft-deleted' })
  async delete(
    @Param('id') id: string,
    @Body() deleteDto: DeleteCustomerDto,
    @GetUser() user: any,
  ) {
    return this.customersService.softDelete(id, user.userId, deleteDto);
  }
}

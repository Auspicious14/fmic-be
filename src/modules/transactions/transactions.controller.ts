import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  UseGuards,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { TransactionsService } from './transactions.service';
import {
  CreateTransactionDto,
  CreateAdjustmentDto,
} from './dto/transaction.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { GetUser } from '../../common/decorators/get-user.decorator';

@ApiTags('Transactions')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('transactions')
export class TransactionsController {
  constructor(private readonly transactionsService: TransactionsService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new transaction (Credit or Payment)' })
  async create(
    @Body() createTransactionDto: CreateTransactionDto,
    @GetUser() user: any,
  ) {
    return this.transactionsService.create(createTransactionDto, user.userId);
  }

  @Post('sync')
  @ApiOperation({ summary: 'Sync offline transactions' })
  async sync(@Body() dtos: CreateTransactionDto[], @GetUser() user: any) {
    return this.transactionsService.syncOfflineTransactions(dtos, user.userId);
  }

  @Post('adjustment')
  @ApiOperation({ summary: 'Create a balance adjustment (Correction)' })
  async createAdjustment(
    @Body() createAdjustmentDto: CreateAdjustmentDto,
    @GetUser() user: any,
  ) {
    return this.transactionsService.createAdjustment(
      createAdjustmentDto,
      user.userId,
    );
  }

  @Get('customer/:customerId')
  @ApiOperation({ summary: 'Get transaction history for a customer' })
  async findByCustomer(
    @Param('customerId') customerId: string,
    @GetUser() user: any,
  ) {
    return this.transactionsService.findByCustomer(customerId, user.userId);
  }

  @Get('daily-summary')
  @ApiOperation({ summary: 'Get daily transaction summary' })
  async getDailySummary(@GetUser() user: any) {
    return this.transactionsService.getDailySummary(user.userId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single transaction' })
  async findOne(@Param('id') id: string, @GetUser() user: any) {
    return this.transactionsService.findOne(id, user.userId);
  }
}

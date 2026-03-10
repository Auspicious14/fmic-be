import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  UseGuards,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { TransactionsService } from './transactions.service';
import { SummaryJobService } from './summary-job.service';
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
  constructor(
    private readonly transactionsService: TransactionsService,
    private readonly summaryJobService: SummaryJobService,
  ) {}

  @Post('trigger-summary')
  @ApiOperation({
    summary: 'Manually trigger a daily summary email (for testing)',
  })
  async triggerSummary(@GetUser() user: any) {
    return this.summaryJobService.triggerManualSummary(user.userId);
  }

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

  @Get()
  @ApiOperation({
    summary: 'Get all transactions (global history with customer name)',
  })
  async findAll(
    @GetUser() user: any,
    @Query('limit') limit?: string,
    @Query('skip') skip?: string,
  ) {
    return this.transactionsService.findAll(
      user.userId,
      limit ? parseInt(limit) : 50,
      skip ? parseInt(skip) : 0,
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
  @ApiOperation({
    summary: 'Get daily transaction summary (fixed with ObjectId casting)',
  })
  async getDailySummary(@GetUser() user: any) {
    return this.transactionsService.getDailySummary(user.userId);
  }

  @Get('weekly-trends')
  @ApiOperation({ summary: 'Get transaction trends for the last 7 days' })
  async getWeeklyTrends(@GetUser() user: any) {
    return this.transactionsService.getWeeklyTrends(user.userId);
  }

  @Get('verify-all')
  @ApiOperation({
    summary: 'Verify integrity of all transactions (audit/reconciliation)',
  })
  async verifyAll(@GetUser() user: any) {
    return this.transactionsService.verifyAllTransactions(user.userId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single transaction' })
  async findOne(@Param('id') id: string, @GetUser() user: any) {
    return this.transactionsService.findOne(id, user.userId);
  }

  @Get(':id/receipt')
  @ApiOperation({ summary: 'Get receipt data (JSON + HTML) for a transaction' })
  async getReceipt(
    @Param('id') id: string,
    @GetUser() user: any,
    @Res() res: Response,
    @Query('format') format?: string,
  ) {
    const result = await this.transactionsService.getReceiptData(
      id,
      user.userId,
      user,
    );

    if (format === 'html') {
      res.setHeader('Content-Type', 'text/html');
      return res.send(result.html);
    }

    return res.json(result);
  }

  @Get(':id/whatsapp')
  @ApiOperation({
    summary: 'Get WhatsApp sharing link and message for receipt',
  })
  async getWhatsAppLink(
    @Param('id') id: string,
    @GetUser() user: any,
    @Query('phone') phone?: string,
  ) {
    return this.transactionsService.getWhatsAppReceiptLink(
      id,
      user.userId,
      user,
      phone,
    );
  }
}

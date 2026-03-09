import { Controller, Get, Param, UseGuards, Ip } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { IntegrityService } from './integrity.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { GetUser } from '../../common/decorators/get-user.decorator';

@ApiTags('Integrity & Evidence')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('integrity')
export class IntegrityController {
  constructor(private readonly integrityService: IntegrityService) {}

  @Get('verify/:transactionId')
  @ApiOperation({
    summary: 'Verify the integrity/tamper-resistance of a transaction',
  })
  async verify(
    @Param('transactionId') transactionId: string,
    @GetUser() user: any,
  ) {
    return this.integrityService.verifyTransactionIntegrity(
      transactionId,
      user.userId,
    );
  }

  @Get('audit/:transactionId')
  @ApiOperation({ summary: 'Get audit logs for a specific transaction' })
  async getAuditLogs(
    @Param('transactionId') transactionId: string,
    @GetUser() user: any,
  ) {
    return this.integrityService.getAuditLogForTransaction(
      transactionId,
      user.userId,
    );
  }

  @Get('evidence/:transactionId')
  @ApiOperation({ summary: 'Retrieve full evidence for dispute resolution' })
  async getEvidence(
    @Param('transactionId') transactionId: string,
    @GetUser() user: any,
  ) {
    return this.integrityService.getTransactionEvidence(
      transactionId,
      user.userId,
    );
  }
}

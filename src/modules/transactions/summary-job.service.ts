import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { MailerService } from '@nestjs-modules/mailer';
import { TransactionsService } from './transactions.service';
import { AuthService } from '../auth/auth.service';

@Injectable()
export class SummaryJobService {
  private readonly logger = new Logger(SummaryJobService.name);

  constructor(
    private readonly transactionsService: TransactionsService,
    private readonly authService: AuthService,
    private readonly mailerService: MailerService,
  ) {}

  /**
   * Run daily summary job at 11:30 PM
   */
  @Cron('30 23 * * *')
  async handleDailySummaryCron() {
    this.logger.log('Starting daily summary automated job...');

    const users = await this.authService.findAll();
    this.logger.log(`Found ${users.length} users to process.`);

    for (const user of users) {
      try {
        await this.processUserSummary(user);
      } catch (error) {
        this.logger.error(
          `Failed to process summary for user ${user.email}:`,
          error.stack,
        );
      }
    }

    this.logger.log('Daily summary automated job completed.');
  }

  private async processUserSummary(user: any) {
    const summary = await this.transactionsService.getDailySummary(
      user._id.toString(),
    );

    if (summary.totalTransactions === 0) {
      this.logger.log(
        `Skipping summary for ${user.email} (No transactions today).`,
      );
      return;
    }

    this.logger.log(`Sending summary email to ${user.email}...`);

    // Simple currency formatting for email
    const fmt = (val: number) => `NGN ${val.toLocaleString()}`;

    await this.mailerService.sendMail({
      to: user.email,
      subject: `Daily Business Summary - ${summary.date}`,
      html: `
        <div style="font-family: sans-serif; max-width: 600px; margin: auto; border: 1px solid #eee; padding: 20px; border-radius: 10px;">
          <h2 style="color: #333;">Daily Business Summary</h2>
          <p>Hello <strong>${user.name}</strong>,</p>
          <p>Here is your business performance summary for today, <strong>${summary.date}</strong>:</p>
          
          <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
            <tr style="background: #f9f9f9;">
              <td style="padding: 10px; border-bottom: 1px solid #eee;">Total Transactions</td>
              <td style="padding: 10px; border-bottom: 1px solid #eee; text-align: right; font-weight: bold;">${summary.totalTransactions}</td>
            </tr>
            <tr>
              <td style="padding: 10px; border-bottom: 1px solid #eee;">Payments Received</td>
              <td style="padding: 10px; border-bottom: 1px solid #eee; text-align: right; font-weight: bold; color: #10b981;">${fmt(summary.totalRevenue)}</td>
            </tr>
            <tr style="background: #f9f9f9;">
              <td style="padding: 10px; border-bottom: 1px solid #eee;">Credit Issued</td>
              <td style="padding: 10px; border-bottom: 1px solid #eee; text-align: right; font-weight: bold; color: #ef4444;">${fmt(summary.totalCredit)}</td>
            </tr>
            <tr>
              <td style="padding: 10px; border-bottom: 1px solid #eee; font-size: 1.1em;">Net Cash Flow</td>
              <td style="padding: 10px; border-bottom: 1px solid #eee; text-align: right; font-weight: 800; font-size: 1.1em;">${fmt(summary.totalRevenue - summary.totalCredit)}</td>
            </tr>
          </table>

          <p>Unique Customers Served: <strong>${summary.uniqueCustomers}</strong></p>
          
          <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; font-size: 0.8em; color: #999; text-align: center;">
            Sent automatically by FMIC Transaction System.<br/>
            &copy; 2026 ${user.shopName}
          </div>
        </div>
      `,
    });

    this.logger.log(`Summary email sent to ${user.email} successfully.`);
  }

  /**
   * Manual trigger for testing
   */
  async triggerManualSummary(userId: string) {
    const user = await this.authService.validateUser({ sub: userId });
    if (user) {
      await this.processUserSummary(user);
      return { message: 'Summary email triggered successfully' };
    }
    throw new Error('User not found');
  }
}

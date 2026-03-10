import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './modules/auth/auth.module';
import { CustomersModule } from './modules/customers/customers.module';
import { ProductsModule } from './modules/products/products.module';
import { TransactionsModule } from './modules/transactions/transactions.module';
import { VoiceModule } from './modules/voice/voice.module';
import { IntegrityModule } from './modules/integrity/integrity.module';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { ScheduleModule } from '@nestjs/schedule';
import { MailerModule } from '@nestjs-modules/mailer';
import { HandlebarsAdapter } from '@nestjs-modules/mailer/dist/adapters/handlebars.adapter';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        uri: configService.get<string>('MONGODB_URI'),
      }),
      inject: [ConfigService],
    }),
    AuthModule,
    CustomersModule,
    ProductsModule,
    TransactionsModule,
    VoiceModule,
    IntegrityModule,
    RealtimeModule,
    ScheduleModule.forRoot(),
    MailerModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        transport: {
          host: configService.get('MAIL_HOST') || 'localhost',
          port: configService.get('MAIL_PORT') || 1025,
          ignoreTLS: true,
          secure: false,
          auth: {
            user: configService.get('MAIL_USER') || 'user',
            pass: configService.get('MAIL_PASS') || 'pass',
          },
        },
        defaults: {
          from: '"FMIC Support" <noreply@fmic.example.com>',
        },
        template: {
          dir: __dirname + '/templates',
          adapter: new HandlebarsAdapter(),
          options: {
            strict: true,
          },
        },
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}

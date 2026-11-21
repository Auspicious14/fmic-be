import { Controller, Post, Body, HttpCode, HttpStatus, Get, UseGuards, Patch } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { LoginDto, RegisterDto } from './dto/auth.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { GetUser } from '../../common/decorators/get-user.decorator';

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @ApiOperation({ summary: 'Register a new shop owner' })
  @ApiResponse({ status: 201, description: 'User successfully registered' })
  async register(@Body() registerDto: RegisterDto) {
    return this.authService.register(registerDto);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login as a shop owner' })
  @ApiResponse({ status: 200, description: 'User successfully logged in' })
  async login(@Body() loginDto: LoginDto) {
    return this.authService.login(loginDto);
  }

  @Get('profile')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current user profile' })
  @ApiResponse({ status: 200, description: 'Return current user profile' })
  async getProfile(@GetUser() user: any) {
    return this.authService.validateUser(user);
  }

  @Patch('whatsapp')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Link the WhatsApp number this shop will message Ledga from' })
  async setWhatsapp(@GetUser() user: any, @Body() body: { phone?: string | null }) {
    return this.authService.setWhatsappPhone(user.userId, body?.phone ?? null);
  }

  @Patch('payout')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Set the bank account customers pay into (shown on receipts)' })
  async setPayout(
    @GetUser() user: any,
    @Body() body: { bank?: string; accountNumber?: string; accountName?: string } | null,
  ) {
    return this.authService.setPayout(user.userId, body ?? null);
  }
}

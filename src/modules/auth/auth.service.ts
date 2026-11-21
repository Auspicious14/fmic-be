import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { User, UserDocument } from './schemas/user.schema';
import { LoginDto, RegisterDto } from './dto/auth.dto';
import { normalizeNigerianPhone } from '../../common/utils/phone';
import { parsePayoutDetails } from '../../common/utils/banks';

@Injectable()
export class AuthService {
  constructor(
    @InjectModel(User.name) private userModel: Model<UserDocument>,
    private jwtService: JwtService,
  ) {}

  async register(registerDto: RegisterDto) {
    const { email, password, name, shopName } = registerDto;

    const existingUser = await this.userModel.findOne({ email });
    if (existingUser) {
      throw new ConflictException('Email already exists');
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new this.userModel({
      email,
      password: hashedPassword,
      name,
      shopName,
    });

    await user.save();
    return this.generateTokens(user);
  }

  async login(loginDto: LoginDto) {
    const { email, password } = loginDto;
    const user = await this.userModel.findOne({ email });

    if (!user || !(await bcrypt.compare(password, user.password))) {
      throw new UnauthorizedException('Invalid credentials');
    }

    return this.generateTokens(user);
  }

  private async generateTokens(user: UserDocument) {
    const payload = { email: user.email, sub: user._id, role: user.role };
    return {
      access_token: this.jwtService.sign(payload),
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        shopName: user.shopName,
      },
    };
  }

  async validateUser(payload: any) {
    // Never send the password hash to the browser.
    return this.userModel.findById(payload.userId).select('-password');
  }

  /** Links (or unlinks, with an empty value) the shop's WhatsApp number. */
  async setWhatsappPhone(userId: string, phone: string | null) {
    const normalized = phone ? normalizeNigerianPhone(phone) : null;
    if (phone && !normalized) {
      throw new BadRequestException('Enter a valid phone number, e.g. 08031234567');
    }
    if (normalized) {
      const taken = await this.userModel.findOne({
        whatsappPhone: normalized,
        _id: { $ne: userId },
      });
      if (taken) {
        throw new ConflictException('This WhatsApp number is already linked to another shop');
      }
    }
    return this.userModel
      .findByIdAndUpdate(
        userId,
        normalized ? { whatsappPhone: normalized } : { $unset: { whatsappPhone: 1 } },
        { new: true },
      )
      .select('-password');
  }

  /** Saves (or clears, with null) the account customers pay into. */
  async setPayout(
    userId: string,
    input: { bank?: string; accountNumber?: string; accountName?: string } | null,
  ) {
    if (!input || (!input.bank && !input.accountNumber && !input.accountName)) {
      return this.userModel
        .findByIdAndUpdate(
          userId,
          { $unset: { payoutBank: 1, payoutAccountNumber: 1, payoutAccountName: 1 } },
          { new: true },
        )
        .select('-password');
    }
    const parsed = parsePayoutDetails(input);
    if ('error' in parsed) throw new BadRequestException(parsed.error);
    const { bank, accountNumber, accountName } = parsed.details;
    return this.userModel
      .findByIdAndUpdate(
        userId,
        { payoutBank: bank, payoutAccountNumber: accountNumber, payoutAccountName: accountName },
        { new: true },
      )
      .select('-password');
  }

  async findAll() {
    return this.userModel.find().exec();
  }
}

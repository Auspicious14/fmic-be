import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  UseGuards,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ProductsService } from './products.service';
import { CreateProductDto, UpdatePriceDto } from './dto/product.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { GetUser } from '../../common/decorators/get-user.decorator';

@ApiTags('Products')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Post()
  @ApiOperation({ summary: 'Add a new product' })
  async create(
    @Body() createProductDto: CreateProductDto,
    @GetUser() user: any,
  ) {
    return this.productsService.create(createProductDto, user.userId);
  }

  @Get()
  @ApiOperation({ summary: 'Get all products' })
  async findAll(@GetUser() user: any) {
    return this.productsService.findAll(user.userId);
  }

  @Get('search')
  @ApiOperation({ summary: 'Search products by name' })
  async search(@Query('q') q: string, @GetUser() user: any) {
    return this.productsService.search(q, user.userId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single product' })
  async findOne(@Param('id') id: string, @GetUser() user: any) {
    return this.productsService.findOne(id, user.userId);
  }

  @Patch(':id/price')
  @ApiOperation({ summary: 'Update product price (creates a new version)' })
  async updatePrice(
    @Param('id') id: string,
    @Body() updatePriceDto: UpdatePriceDto,
    @GetUser() user: any,
  ) {
    return this.productsService.updatePrice(id, updatePriceDto, user.userId);
  }

  @Get(':id/history')
  @ApiOperation({ summary: 'Get pricing history for a product' })
  async getHistory(@Param('id') id: string, @GetUser() user: any) {
    return this.productsService.getPriceHistory(id, user.userId);
  }
}

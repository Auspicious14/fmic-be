
import {
  Controller,
  Post,
  Body,
  UseGuards,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiConsumes,
} from '@nestjs/swagger';
import { VoiceService } from './voice.service';
import { GroqService } from './services/groq.service';
import { KokoroService } from './services/kokoro.service';
import { ProcessVoiceDto } from './dto/voice.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { FileInterceptor } from '@nestjs/platform-express';
import { ThrottlerGuard } from '@nestjs/throttler';

@ApiTags('Voice Processing')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, ThrottlerGuard)
@Controller('voice')
export class VoiceController {
  constructor(
    private readonly voiceService: VoiceService,
    private readonly groqService: GroqService,
    private readonly kokoroService: KokoroService,
  ) {}

  @Post('process')
  @ApiOperation({
    summary: 'Process voice transcript to Llama 3.3 structured data',
  })
  async process(
    @Body() processVoiceDto: ProcessVoiceDto,
    @GetUser() user: { userId: string },
  ) {
    return this.voiceService.processTranscript(processVoiceDto, user.userId);
  }

  @Post('ingest-audio')
  @ApiOperation({ summary: 'Ingest raw audio via Whisper STT + Llama 3.3 NLU' })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(
    FileInterceptor('audio', {
      limits: { fileSize: 10 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        const allowed = new Set([
          'audio/webm',
          'audio/ogg',
          'audio/wav',
          'audio/mpeg',
          'audio/mp4',
          'video/webm',
        ]);
        cb(null, allowed.has(file.mimetype));
      },
    }),
  )
  async ingestAudio(
    @UploadedFile() file: { buffer: Buffer; mimetype: string },
    @GetUser() user: { userId: string },
  ) {
    return this.voiceService.processAudio(file, user.userId);
  }

  @Post('stt')
  @ApiOperation({ summary: 'Groq Whisper STT endpoint' })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('audio'))
  async stt(@UploadedFile() file: { buffer: Buffer; mimetype: string }) {
    const result = await this.groqService.transcribe(file.buffer, file.mimetype);
    return { text: result.text, confidence: result.confidence };
  }

  @Post('tts')
  @ApiOperation({ summary: 'Kokoro TTS endpoint' })
  async tts(@Body() body: { text: string; lang?: string }) {
    const base64Wav = await this.kokoroService.generateTTS(body.text, body.lang || 'pcm-NG');
    return { audio: base64Wav };
  }
}

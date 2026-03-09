import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger, UseGuards } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

@WebSocketGateway({
  cors: {
    origin: '*',
  },
})
export class RealtimeGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private logger: Logger = new Logger('RealtimeGateway');

  constructor(private jwtService: JwtService) {}

  async handleConnection(client: Socket) {
    const token = client.handshake.auth.token;
    try {
      const payload = this.jwtService.verify(token);
      client.join(`shop_${payload.sub}`);
      this.logger.log(
        `Client connected: ${client.id} joined shop_${payload.sub}`,
      );
    } catch (e) {
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  sendTransactionUpdate(shopOwnerId: string, data: any) {
    this.server.to(`shop_${shopOwnerId}`).emit('transaction_update', data);
  }

  sendVoiceExtractionResult(shopOwnerId: string, data: any) {
    this.server.to(`shop_${shopOwnerId}`).emit('voice_extraction', data);
  }
}

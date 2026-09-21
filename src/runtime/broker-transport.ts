import type { Socket } from 'node:net';
import { BrokerError } from './broker-errors.js';
import { BROKER_MAX_FRAME_BYTES, decodeBrokerFrame, encodeBrokerFrame, type BrokerMessage } from './broker-protocol.js';
export function sendBrokerMessage(socket: Socket, message: BrokerMessage): void { socket.write(encodeBrokerFrame(message)); }
export function readBrokerFrames(socket: Socket, onMessage: (message: BrokerMessage) => void, onError: (error: BrokerError) => void): () => void {
  let buffer = Buffer.alloc(0); let closed = false;
  const fail = (error: BrokerError) => { if (closed) return; closed = true; onError(error); };
  const onData = (chunk: Buffer) => { if (closed) return; buffer = Buffer.concat([buffer, chunk]); while (buffer.length >= 4) { const size = buffer.readUInt32BE(0); if (size > BROKER_MAX_FRAME_BYTES) { fail(new BrokerError('frame_too_large')); return; } if (buffer.length < size + 4) return; const frame = buffer.subarray(0, size + 4); buffer = buffer.subarray(size + 4); try { onMessage(decodeBrokerFrame(frame)); } catch (error) { fail(error instanceof BrokerError ? error : new BrokerError('invalid_frame')); return; } } };
  const onSocketError = () => fail(new BrokerError('transport_closed'));
  const onClose = () => fail(new BrokerError('transport_closed'));
  socket.on('data', onData); socket.once('error', onSocketError); socket.once('close', onClose);
  return () => { closed = true; socket.off('data', onData); socket.off('error', onSocketError); socket.off('close', onClose); };
}

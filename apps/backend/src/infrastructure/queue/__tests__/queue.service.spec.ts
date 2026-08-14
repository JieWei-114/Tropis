import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { QueueService, NotificationJobData } from '../queue.service';
import { QUEUE_NOTIFICATION, QUEUE_FILE_PROCESSING } from '../queue.constants';

const mockQueue = () => ({
  add: jest.fn().mockResolvedValue({ id: 'job-1' }),
  getWaitingCount: jest.fn().mockResolvedValue(2),
  getActiveCount: jest.fn().mockResolvedValue(1),
  getCompletedCount: jest.fn().mockResolvedValue(10),
  getFailedCount: jest.fn().mockResolvedValue(0),
});

describe('QueueService', () => {
  let service: QueueService;
  let notificationQueue: ReturnType<typeof mockQueue>;
  let fileQueue: ReturnType<typeof mockQueue>;

  const notificationJob: NotificationJobData = {
    userId: 'user-123',
    channel: 'email',
    template: 'welcome',
    payload: { name: 'Alice' },
  };

  beforeEach(async () => {
    notificationQueue = mockQueue();
    fileQueue = mockQueue();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        QueueService,
        {
          provide: getQueueToken(QUEUE_NOTIFICATION),
          useValue: notificationQueue,
        },
        { provide: getQueueToken(QUEUE_FILE_PROCESSING), useValue: fileQueue },
      ],
    }).compile();

    service = module.get(QueueService);
  });

  describe('enqueueNotification', () => {
    it('adds job to the notification queue with default retry options', async () => {
      await service.enqueueNotification('send-notification', notificationJob);

      expect(notificationQueue.add).toHaveBeenCalledWith(
        'send-notification',
        notificationJob,
        expect.objectContaining({ attempts: 3 }),
      );
    });

    it('merges caller-supplied options on top of defaults', async () => {
      await service.enqueueNotification('send-notification', notificationJob, {
        priority: 1,
      });

      expect(notificationQueue.add).toHaveBeenCalledWith(
        'send-notification',
        notificationJob,
        expect.objectContaining({ priority: 1, attempts: 3 }),
      );
    });
  });

  describe('enqueueDelayedNotification', () => {
    it('passes delay option to the queue', async () => {
      await service.enqueueDelayedNotification(
        'send-notification',
        notificationJob,
        30_000,
      );

      expect(notificationQueue.add).toHaveBeenCalledWith(
        'send-notification',
        notificationJob,
        expect.objectContaining({ delay: 30_000 }),
      );
    });
  });

  describe('enqueueFileProcessing', () => {
    it('adds job to the file-processing queue', async () => {
      await service.enqueueFileProcessing('process-file', {
        fileKey: 'uploads/photo.jpg',
        bucket: 'avatars',
        userId: 'user-123',
        operation: 'resize',
      });

      expect(fileQueue.add).toHaveBeenCalledWith(
        'process-file',
        expect.objectContaining({ bucket: 'avatars' }),
        expect.objectContaining({ attempts: 2 }),
      );
    });
  });

  describe('getNotificationQueueStats', () => {
    it('returns aggregated queue counts', async () => {
      const stats = await service.getNotificationQueueStats();

      expect(stats).toEqual({
        waiting: 2,
        active: 1,
        completed: 10,
        failed: 0,
      });
    });
  });
});

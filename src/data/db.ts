import Dexie from 'dexie';
import type { Table } from 'dexie';
import type {
  ApprovalItem,
  AuditEvent,
  DayClose,
  Delivery,
  Shift,
  Bar,
  Category,
  Device,
  Keg,
  Order,
  OrderLine,
  Payment,
  Person,
  Product,
  ProductSize,
  StockMovement,
} from '../domain/types';
import type { AdminOutboxEntry } from './adminEvents';
import type { OutboxEntry } from './events';

export interface MetaRow {
  key: string;
  value: unknown;
}

/**
 * The counter's local store (IndexedDB). The UI reads only from here, so the
 * app works with no network; every write also lands in `outbox` (R-SYNC-1).
 */
export class KauntaDB extends Dexie {
  bar!: Table<Bar, string>;
  categories!: Table<Category, string>;
  people!: Table<Person, string>;
  devices!: Table<Device, string>;
  products!: Table<Product, string>;
  sizes!: Table<ProductSize, string>;
  kegs!: Table<Keg, string>;
  orders!: Table<Order, string>;
  lines!: Table<OrderLine, string>;
  payments!: Table<Payment, string>;
  stockMovements!: Table<StockMovement, string>;
  approvals!: Table<ApprovalItem, string>;
  shifts!: Table<Shift, string>;
  deliveries!: Table<Delivery, string>;
  dayCloses!: Table<DayClose, string>;
  auditEvents!: Table<AuditEvent, string>;
  outbox!: Table<OutboxEntry, number>;
  adminOutbox!: Table<AdminOutboxEntry, number>;
  meta!: Table<MetaRow, string>;

  constructor(name = 'kaunta') {
    super(name);
    this.version(1).stores({
      bar: 'id',
      categories: 'id, sort',
      people: 'id, role',
      devices: 'id',
      products: 'id, category_id',
      sizes: 'id, product_id',
      kegs: 'id, product_id, [product_id+status]',
      orders: 'id, business_day, status, [business_day+status]',
      lines: 'id, order_id, keg_id',
      payments: 'id, order_id',
      stockMovements: 'id, product_id, ref_id',
      // `seq` is the send order: assigned by the database, so a device clock
      // that steps backwards can never reorder what staff recorded.
      outbox: '++seq, &id, status',
      meta: 'key',
    });
    this.version(2).stores({
      approvals: 'id, status',
      shifts: 'id, person_id, [person_id+device_id]',
    });
    // Admin (build step 5): deliveries, day closes and the audit log.
    this.version(3).stores({
      deliveries: 'id, created_at',
      dayCloses: 'business_day',
      auditEvents: 'id, at, kind, actor_id, ref_id',
      // What an admin changed, waiting to be sent (same rules as the counter outbox).
      adminOutbox: '++seq, &id, status',
    });
  }
}

export const db = new KauntaDB();

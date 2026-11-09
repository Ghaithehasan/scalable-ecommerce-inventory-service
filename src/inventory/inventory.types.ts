// Match proto-loader's keepCase: false and longs: String settings.
export interface StockItem {
  productId: string;
  quantity: number;
}
export interface GetStockRequest {
  productId: string;
}
export interface GetStockResponse {
  productId: string;
  availableQuantity: number;
}
export interface GetStocksRequest {
  productIds: string[];
}
export interface GetStocksResponse {
  items: GetStockResponse[];
}
export interface ReserveStockRequest {
  reservationId: string;
  items: StockItem[];
}
export interface ReserveStockResponse {
  reservationId: string;
  reservedItems: StockItem[];
}
export interface ReleaseStockRequest {
  reservationId: string;
}
export interface ReleaseStockResponse {
  reservationId: string;
}

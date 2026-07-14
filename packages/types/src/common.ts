/**
 * Standard pagination query parameters.
 */
export interface PaginationQuery {
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

/**
 * Paginated response wrapper.
 */
export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

/**
 * Standard service health check response.
 */
export interface ServiceHealthResponse {
  status: 'UP' | 'DOWN' | 'DEGRADED';
  service: string;
  uptime: number;
  timestamp: string;
}

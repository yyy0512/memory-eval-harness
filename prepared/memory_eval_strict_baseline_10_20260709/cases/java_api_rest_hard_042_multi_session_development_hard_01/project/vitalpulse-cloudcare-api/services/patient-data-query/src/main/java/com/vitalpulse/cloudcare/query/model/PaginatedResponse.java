package com.vitalpulse.cloudcare.query.model;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.annotation.JsonPropertyOrder;

import javax.validation.constraints.NotNull;
import javax.validation.constraints.PositiveOrZero;
import java.io.Serial;
import java.io.Serializable;
import java.util.Collections;
import java.util.List;
import java.util.Objects;

/**
 * Immutable, generic model that wraps a single “page” of results together with
 * low-overhead cursor information.  Designed with DynamoDB’s exclusive start key
 * semantics in mind, so that a cursor can be opaque to the consumer while still
 * representing a deterministic read position for the service layer.
 *
 * <p>Example JSON payload:
 * <pre>
 * {
 *   "items"      : [ { ... }, { ... } ],
 *   "nextCursor" : "eyJrZXkiOiIxMjM0NTY3ODkwIn0=",
 *   "prevCursor" : null,
 *   "pageSize"   : 25,
 *   "totalCount" : 314
 * }
 * </pre>
 *
 * <p>The class is Serializable to allow end-to-end tracing via asynchronous
 * queues (e.g., AWS SQS) and cache storage (e.g., ElastiCache) without any additional
 * marshalling logic.</p>
 *
 * @param <T> Type of the individual data elements contained in the page.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
@JsonPropertyOrder({ "items", "nextCursor", "prevCursor", "pageSize", "totalCount" })
public final class PaginatedResponse<T> implements Serializable {

    @Serial
    private static final long serialVersionUID = 8721043397960136124L;

    @JsonProperty("items")
    @NotNull
    private final List<T> items;

    @JsonProperty("nextCursor")
    private final String nextCursor;

    @JsonProperty("prevCursor")
    private final String prevCursor;

    @JsonProperty("pageSize")
    @PositiveOrZero
    private final int pageSize;

    @JsonProperty("totalCount")
    @PositiveOrZero
    private final Long totalCount;

    /**
     * Public factory method to build an immutable {@link PaginatedResponse}.
     *
     * @param items       page elements (never {@code null})
     * @param nextCursor  opaque cursor pointing to the next page (may be {@code null} when on the last page)
     * @param prevCursor  opaque cursor pointing to the previous page (may be {@code null} when on the first page)
     * @param totalCount  total amount of elements available for the query (optional,
     *                    costly to compute on some datastores, may be {@code null})
     * @throws NullPointerException when {@code items} is {@code null}
     */
    public static <T> PaginatedResponse<T> of(
            final List<T> items,
            final String nextCursor,
            final String prevCursor,
            final Long totalCount
    ) {
        Objects.requireNonNull(items, "items must not be null");
        return new PaginatedResponse<>(
                List.copyOf(items),
                nextCursor,
                prevCursor,
                items.size(),
                totalCount
        );
    }

    /**
     * Convenience method when only “next” navigation is supported.
     * @see #of(List, String, String, Long)
     */
    public static <T> PaginatedResponse<T> ofNextOnly(
            final List<T> items,
            final String nextCursor,
            final Long totalCount
    ) {
        return of(items, nextCursor, null, totalCount);
    }

    private PaginatedResponse(
            final List<T> items,
            final String nextCursor,
            final String prevCursor,
            final int pageSize,
            final Long totalCount
    ) {
        this.items = items;
        this.nextCursor = nextCursor;
        this.prevCursor = prevCursor;
        this.pageSize = pageSize;
        this.totalCount = totalCount;
    }

    /* ==============================  Accessors  ================================= */

    public List<T> getItems() {
        return Collections.unmodifiableList(items);
    }

    public String getNextCursor() {
        return nextCursor;
    }

    public String getPrevCursor() {
        return prevCursor;
    }

    public int getPageSize() {
        return pageSize;
    }

    public Long getTotalCount() {
        return totalCount;
    }

    /* ==============================  Helpers  =================================== */

    /**
     * Indicates that there is another page available after the current one.
     *
     * @return {@code true} when {@link #getNextCursor()} is not {@code null}
     */
    public boolean hasNext() {
        return nextCursor != null && !nextCursor.isBlank();
    }

    /**
     * Indicates that there is a page available in the reverse direction.
     *
     * @return {@code true} when {@link #getPrevCursor()} is not {@code null}
     */
    public boolean hasPrevious() {
        return prevCursor != null && !prevCursor.isBlank();
    }

    /* ==============================  Overrides  ================================= */

    @Override
    public String toString() {
        return "PaginatedResponse{" +
               "items=" + items +
               ", nextCursor='" + nextCursor + '\'' +
               ", prevCursor='" + prevCursor + '\'' +
               ", pageSize=" + pageSize +
               ", totalCount=" + totalCount +
               '}';
    }

    @Override
    public int hashCode() {
        return Objects.hash(items, nextCursor, prevCursor, pageSize, totalCount);
    }

    @Override
    public boolean equals(final Object obj) {
        if (this == obj) return true;
        if (!(obj instanceof PaginatedResponse<?> that)) return false;
        return pageSize == that.pageSize &&
               Objects.equals(items, that.items) &&
               Objects.equals(nextCursor, that.nextCursor) &&
               Objects.equals(prevCursor, that.prevCursor) &&
               Objects.equals(totalCount, that.totalCount);
    }
}
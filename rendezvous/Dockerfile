# Build stage. Pinned to the toolchain in go.mod so a deploy never silently
# picks up a different compiler than the one the tests ran under.
FROM golang:1.26-alpine AS build

WORKDIR /src

# Dependencies first: this layer only rebuilds when go.mod/go.sum move, so an
# ordinary code change does not re-download the module cache.
COPY go.mod go.sum ./
RUN go mod download

COPY . .

# Static binary, no cgo, no symbol table. The service reads no files at runtime
# and holds all state in memory, so it needs nothing else in the image.
RUN CGO_ENABLED=0 GOOS=linux go build \
      -trimpath \
      -ldflags="-s -w" \
      -o /out/rendezvousd ./cmd/rendezvousd

# Run stage. Scratch rather than alpine: there is no shell to exec into and no
# package surface to keep patched, which is the right trade for a service whose
# entire job is to hold short-lived records in memory.
FROM scratch

# The service makes no outbound HTTPS calls, but a CA bundle costs ~200KB and
# means a future one does not fail with an unexplained x509 error.
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=build /out/rendezvousd /rendezvousd

# Non-root. There is no /etc/passwd in scratch, so this is a bare uid — which
# is all the kernel needs and all we want it to have.
USER 65534:65534

EXPOSE 8080

# TLS is terminated by the platform in front of this. NEX_RENDEZVOUS_TLS_CERT
# and _KEY exist for running it directly, and are left unset here.
ENV NEX_RENDEZVOUS_ADDR=:8080

ENTRYPOINT ["/rendezvousd"]

# Both base images are pinned to their linux/amd64 manifests. Update a digest
# only in a deliberate change, because it changes the image digest.

# golang:1.24.6-bookworm
FROM golang:1.24.6-bookworm@sha256:4f8589362626cfa081fdab2b474cda87c3b51d74b1e227c110d2ffde56daad5c AS build
ARG SOURCE_DATE_EPOCH
ENV CGO_ENABLED=0 GOOS=linux GOARCH=amd64 GOTOOLCHAIN=local GOFLAGS=-mod=readonly
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
RUN go build -trimpath -buildvcs=false -ldflags "-s -w -buildid=" -o /out/tee ./cmd/tee

# gcr.io/distroless/static-debian12
FROM gcr.io/distroless/static-debian12@sha256:6d635b323e6ab633016668144d38e368e2894bd824500369151573225078ee03
ARG SOURCE_DATE_EPOCH
LABEL tee.launch_policy.allow_cmd_override="true"
LABEL tee.launch_policy.allow_env_override="STORAGE_BUCKET"
# The TLS roots for chain reads. They come from the pinned build image, so they
# are part of the attested image, and the TEE loads only this file.
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/paperseal/roots.pem
COPY --from=build /out/tee /tee
EXPOSE 8080
# No CMD: the exam settings arrive through tee-cmd, which overrides CMD.
ENTRYPOINT ["/tee"]

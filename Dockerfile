ARG CLOUDFLARED_VERSION=2026.3.0

# Pull cloudflared from a builder image. The authelia base image's busybox
# wget can't follow GitHub release redirects, so we stage the binary here.
FROM cloudflare/cloudflared:${CLOUDFLARED_VERSION} AS cloudflared

FROM authelia/authelia:latest

# The Authelia image is Ubuntu-based and minimal (wget available, no curl or apt-get).
# We use wget for snapshot save/restore against the Worker.

COPY --from=cloudflared /usr/local/bin/cloudflared /usr/local/bin/cloudflared

RUN mkdir -p /data

COPY authelia/configuration.yml /config/configuration.yml
COPY container-entrypoint.sh /entrypoint.sh
COPY notif-forwarder.sh /usr/local/bin/notif-forwarder.sh
RUN chmod +x /entrypoint.sh /usr/local/bin/notif-forwarder.sh

EXPOSE 9091

ENTRYPOINT ["/entrypoint.sh"]

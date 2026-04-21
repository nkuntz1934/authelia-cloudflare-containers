FROM authelia/authelia:latest

# The Authelia image is Ubuntu-based and minimal (wget available, no curl or apt-get).
# We use wget for snapshot save/restore against the Worker.

RUN mkdir -p /data

COPY authelia/configuration.easydemo.yml /config/configuration.yml
COPY container-entrypoint.sh /entrypoint.sh
COPY notif-forwarder.sh /usr/local/bin/notif-forwarder.sh
RUN chmod +x /entrypoint.sh /usr/local/bin/notif-forwarder.sh

EXPOSE 9091

ENTRYPOINT ["/entrypoint.sh"]

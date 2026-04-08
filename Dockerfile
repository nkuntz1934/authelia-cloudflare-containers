FROM authelia/authelia:latest

RUN mkdir -p /data

COPY authelia/configuration.yml /config/configuration.yml

EXPOSE 9091

ENTRYPOINT ["authelia"]
CMD ["--config", "/config/configuration.yml"]

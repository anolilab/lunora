# The smallest HTTP server that proves a request reached the container.
FROM busybox:1.36
RUN mkdir /www && echo "hello from a celld container" > /www/hello
EXPOSE 8080
CMD ["httpd", "-f", "-p", "8080", "-h", "/www"]

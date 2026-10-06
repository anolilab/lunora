/**
 * A throwaway certificate authority and a server certificate for 127.0.0.1
 * (and `localhost`), for tests that serve artifacts over HTTPS to the daemon.
 *
 * The daemon trusts the system's roots through rustls, which `SSL_CERT_FILE`
 * replaces: point it at {@link TestTls.caFile}. A CA and a leaf, not one
 * self-signed certificate: `openssl req -x509` marks its certificate a CA, and
 * webpki refuses a CA certificate as a server's own.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

interface TestTls {
    /** The CA certificate (PEM), for `SSL_CERT_FILE`. */
    caFile: string;
    /** The server's certificate (PEM). */
    cert: string;
    /** The server's private key (PEM). */
    key: string;
}

/** Make the CA and the server certificate in `directory` with OpenSSL. */
const createTestTls = (directory: string, openssl = "openssl"): TestTls => {
    const path = (name: string): string => join(directory, name);
    const run = (args: string[]): void => {
        // eslint-disable-next-line sonarjs/no-os-command-from-path -- `openssl` by default: a workstation's, wherever it is; the lane passes an absolute path
        execFileSync(openssl, args, { stdio: "ignore" });
    };

    // The leaf's extensions: a server certificate for 127.0.0.1 and localhost, not a CA.
    const extensions = [
        "basicConstraints=critical,CA:FALSE",
        "keyUsage=critical,digitalSignature",
        "extendedKeyUsage=serverAuth",
        "subjectAltName=IP:127.0.0.1,DNS:localhost",
    ];

    writeFileSync(path("leaf.ext"), `${extensions.join("\n")}\n`);
    run([
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        "-nodes",
        "-keyout",
        path("ca.key"),
        "-out",
        path("ca.pem"),
        "-days",
        "2",
        "-subj",
        "/CN=lunora-hostd test CA",
    ]);
    run([
        "req",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        "-nodes",
        "-keyout",
        path("tls.key"),
        "-out",
        path("tls.csr"),
        "-subj",
        "/CN=127.0.0.1",
    ]);
    run([
        "x509",
        "-req",
        "-in",
        path("tls.csr"),
        "-CA",
        path("ca.pem"),
        "-CAkey",
        path("ca.key"),
        "-CAcreateserial",
        "-out",
        path("tls.pem"),
        "-days",
        "2",
        "-extfile",
        path("leaf.ext"),
    ]);

    return { caFile: path("ca.pem"), cert: path("tls.pem"), key: path("tls.key") };
};

export type { TestTls };
export { createTestTls };

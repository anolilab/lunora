//! The box's identity (D4): an Ed25519 key pair generated on the box at
//! enrolment. The control plane stores only the raw public key, base64url
//! without padding (43 characters); the private key never leaves its file
//! (PKCS#8 PEM, 0600 — the format the TypeScript daemon wrote, so a box keeps
//! its key across the switch).

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::SigningKey;
use ed25519_dalek::pkcs8::spki::der::pem::LineEnding;
use ed25519_dalek::pkcs8::{DecodePrivateKey, EncodePrivateKey};

use super::config::{is_open_to_others, permissions_of, write_file_atomic};

#[derive(Clone)]
pub struct Identity {
    key: SigningKey,
}

/// Never prints the key.
impl std::fmt::Debug for Identity {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("Identity").field("public_key", &self.public_key()).finish()
    }
}

impl Identity {
    /// The raw public key, base64url without padding: what `POST /v1/boxes/enrol` registers.
    pub fn public_key(&self) -> String {
        URL_SAFE_NO_PAD.encode(self.key.verifying_key().to_bytes())
    }

    /// Sign `payload` (pure Ed25519); the signature as base64url without padding, 86 characters.
    pub fn sign(&self, payload: &[u8]) -> String {
        use ed25519_dalek::Signer;

        URL_SAFE_NO_PAD.encode(self.key.sign(payload).to_bytes())
    }

    /// The public half, for the tests' fake control plane to verify against.
    pub fn verifying_key(&self) -> ed25519_dalek::VerifyingKey {
        self.key.verifying_key()
    }
}

/// Generate a fresh key pair and write the private key to `path` (PKCS#8 PEM, 0600).
pub fn generate_identity(path: &Path) -> Result<Identity, String> {
    let mut seed = [0_u8; 32];

    getrandom::fill(&mut seed).map_err(|error| format!("no randomness for the box key: {error}"))?;

    let key = SigningKey::from_bytes(&seed);
    let pem = key.to_pkcs8_pem(LineEnding::LF).map_err(|error| error.to_string())?;

    write_file_atomic(path, pem.as_bytes(), 0o600).map_err(|error| format!("cannot write {}: {error}", path.display()))?;

    Ok(Identity { key })
}

/// Load the box's key from `path`; refused when others may read it or it is not an Ed25519 private key.
pub fn load_identity(path: &Path) -> Result<Identity, String> {
    let metadata = fs::metadata(path).map_err(|error| format!("cannot read the box key {}: {error}", path.display()))?;
    let mode = metadata.permissions().mode();

    if is_open_to_others(mode) {
        return Err(format!("{} is readable by others (mode {:o}); chmod 600 it", path.display(), permissions_of(mode)));
    }

    let pem = fs::read_to_string(path).map_err(|error| format!("cannot read the box key {}: {error}", path.display()))?;

    SigningKey::from_pkcs8_pem(&pem).map(|key| Identity { key }).map_err(|_| format!("{} is not an Ed25519 private key (PKCS#8 PEM)", path.display()))
}

#[cfg(test)]
mod tests {
    use ed25519_dalek::Verifier;

    use super::*;

    #[test]
    fn generates_signs_and_loads_back() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("box.key");
        let identity = generate_identity(&path).unwrap();
        let loaded = load_identity(&path).unwrap();

        assert_eq!(identity.public_key(), loaded.public_key());
        assert_eq!(identity.public_key().len(), 43);

        let signature = loaded.sign(b"payload");
        let bytes: [u8; 64] = URL_SAFE_NO_PAD.decode(&signature).unwrap().try_into().unwrap();

        assert_eq!(signature.len(), 86);
        assert!(identity.verifying_key().verify(b"payload", &ed25519_dalek::Signature::from_bytes(&bytes)).is_ok());
        // The PEM label is assembled, so no key-shaped text sits in the source for the secret scanner to trip on.
        assert!(fs::read_to_string(&path).unwrap().starts_with(&format!("-----BEGIN {}-----", "PRIVATE KEY")));
    }

    #[test]
    fn reads_a_key_node_wrote() {
        // `generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" })`: PKCS#8 v1, no public key.
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("box.key");

        // Built from its DER (the PKCS#8 v1 prefix, then the 32-byte seed), so no key-shaped text sits in the source.
        let der = [&[0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20][..], &[0x11; 32]].concat();
        let pem = format!("-----BEGIN {label}-----\n{}\n-----END {label}-----\n", base64::engine::general_purpose::STANDARD.encode(der), label = "PRIVATE KEY");

        write_file_atomic(&path, pem.as_bytes(), 0o600).unwrap();

        assert_eq!(load_identity(&path).unwrap().public_key(), URL_SAFE_NO_PAD.encode(SigningKey::from_bytes(&[0x11; 32]).verifying_key().to_bytes()));
    }

    #[test]
    fn refuses_a_key_others_can_read() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("box.key");

        generate_identity(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();

        assert!(load_identity(&path).unwrap_err().contains("readable by others (mode 640)"));
    }
}

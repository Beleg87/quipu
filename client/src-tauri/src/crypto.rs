//! Noise_XX_25519 keypair — sole identity in Quipu.
//! The public key fingerprint (hex[:16]) is shown in the UI.
use serde::{Deserialize, Serialize};
use snow::Builder;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct KeypairExport {
    pub public_key:  String,   // full hex
    pub private_key: String,   // full hex — never leaves the device
    pub fingerprint: String,   // first 16 hex chars, used as display identity
}

pub fn generate_keypair() -> anyhow::Result<KeypairExport> {
    let builder = Builder::new("Noise_XX_25519_ChaChaPoly_BLAKE2s".parse()?);
    let keypair = builder.generate_keypair()?;
    let pub_hex = hex::encode(&keypair.public);
    let fp      = pub_hex[..16].to_string();
    Ok(KeypairExport {
        public_key:  pub_hex,
        private_key: hex::encode(&keypair.private),
        fingerprint: fp,
    })
}

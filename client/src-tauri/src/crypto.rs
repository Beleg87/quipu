//! Noise_XX keypair generation. Public key fingerprint = sole identity.
use serde::Serialize;
use snow::Builder;

#[derive(Serialize)]
pub struct KeypairExport {
    pub public_key:  String,
    pub private_key: String,
    pub fingerprint: String,
}

pub fn generate_keypair() -> anyhow::Result<KeypairExport> {
    let builder = Builder::new("Noise_XX_25519_ChaChaPoly_BLAKE2s".parse()?);
    let keypair = builder.generate_keypair()?;
    let pub_hex = hex::encode(&keypair.public);
    let fp      = pub_hex[..16].to_string();
    Ok(KeypairExport { public_key: pub_hex, private_key: hex::encode(&keypair.private), fingerprint: fp })
}

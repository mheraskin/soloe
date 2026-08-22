use std::env;
use std::io::{self, Read, Write};
use std::net::{IpAddr, TcpListener, TcpStream, UdpSocket};
use std::thread;

const DNS_PORT: u16 = 53;
const MAX_DNS_PACKET: usize = 4096;

#[derive(Clone, Debug, PartialEq, Eq)]
struct Config {
    zone: String,
    address: IpAddr,
    listen: IpAddr,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("soloe-device-dns: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let config = parse_args(env::args().skip(1))?;
    let bind = (config.listen, DNS_PORT);
    let udp =
        UdpSocket::bind(bind).map_err(|error| format!("cannot bind UDP {bind:?}: {error}"))?;
    let tcp =
        TcpListener::bind(bind).map_err(|error| format!("cannot bind TCP {bind:?}: {error}"))?;

    let tcp_config = config.clone();
    thread::spawn(move || serve_tcp(tcp, tcp_config));
    serve_udp(udp, config)
}

fn parse_args(args: impl Iterator<Item = String>) -> Result<Config, String> {
    let mut zone = None;
    let mut address = None;
    let mut listen = "0.0.0.0"
        .parse::<IpAddr>()
        .expect("valid default listen address");
    let mut args = args.peekable();
    while let Some(argument) = args.next() {
        let value = match argument.as_str() {
            "--zone" | "--address" | "--listen" => args
                .next()
                .ok_or_else(|| format!("{argument} requires a value"))?,
            "--help" | "-h" => {
                return Err("usage: soloe-device-dns --zone <device> --address <tailscale-ip> [--listen <ip>]".into());
            }
            _ => return Err(format!("unknown argument: {argument}")),
        };
        match argument.as_str() {
            "--zone" => zone = Some(normalize_zone(&value)?),
            "--address" => {
                address = Some(
                    value
                        .parse::<IpAddr>()
                        .map_err(|_| "invalid --address".to_string())?,
                )
            }
            "--listen" => {
                listen = value
                    .parse::<IpAddr>()
                    .map_err(|_| "invalid --listen".to_string())?
            }
            _ => unreachable!(),
        }
    }
    Ok(Config {
        zone: zone.ok_or_else(|| "--zone is required".to_string())?,
        address: address.ok_or_else(|| "--address is required".to_string())?,
        listen,
    })
}

fn normalize_zone(value: &str) -> Result<String, String> {
    let zone = value.trim().trim_end_matches('.').to_ascii_lowercase();
    let valid = !zone.is_empty()
        && zone.len() <= 63
        && zone.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || (byte == b'-' && index > 0 && index + 1 < zone.len())
        });
    if valid {
        Ok(zone)
    } else {
        Err("invalid --zone".into())
    }
}

fn serve_udp(socket: UdpSocket, config: Config) -> Result<(), String> {
    let mut packet = [0_u8; MAX_DNS_PACKET];
    loop {
        let (length, peer) = socket
            .recv_from(&mut packet)
            .map_err(|error| error.to_string())?;
        if let Ok(response) = response_for(&packet[..length], &config) {
            let _ = socket.send_to(&response, peer);
        }
    }
}

fn serve_tcp(listener: TcpListener, config: Config) {
    for stream in listener.incoming().flatten() {
        let config = config.clone();
        thread::spawn(move || {
            let _ = serve_tcp_stream(stream, &config);
        });
    }
}

fn serve_tcp_stream(mut stream: TcpStream, config: &Config) -> io::Result<()> {
    loop {
        let mut size = [0_u8; 2];
        if stream.read_exact(&mut size).is_err() {
            return Ok(());
        }
        let length = u16::from_be_bytes(size) as usize;
        if length == 0 || length > MAX_DNS_PACKET {
            return Ok(());
        }
        let mut packet = vec![0_u8; length];
        stream.read_exact(&mut packet)?;
        let response = response_for(&packet, config).unwrap_or_else(|_| servfail(&packet));
        stream.write_all(&(response.len() as u16).to_be_bytes())?;
        stream.write_all(&response)?;
    }
}

fn response_for(packet: &[u8], config: &Config) -> Result<Vec<u8>, String> {
    if packet.len() < 12 || u16::from_be_bytes([packet[4], packet[5]]) != 1 {
        return Err("unsupported DNS request".into());
    }
    let (name, question_end) = read_name(packet, 12)?;
    if question_end + 4 > packet.len() {
        return Err("truncated DNS question".into());
    }
    let question_type = u16::from_be_bytes([packet[question_end], packet[question_end + 1]]);
    let question_class = u16::from_be_bytes([packet[question_end + 2], packet[question_end + 3]]);
    let question_end = question_end + 4;
    let in_zone = name == config.zone || name.ends_with(&format!(".{}", config.zone));
    let address_type = match config.address {
        IpAddr::V4(_) => 1,
        IpAddr::V6(_) => 28,
    };
    let answer =
        in_zone && question_class == 1 && (question_type == address_type || question_type == 255);

    let mut response = Vec::with_capacity(64 + question_end);
    response.extend_from_slice(&packet[0..2]);
    let request_flags = u16::from_be_bytes([packet[2], packet[3]]);
    let flags = 0x8400 | (request_flags & 0x0100) | if in_zone { 0 } else { 3 };
    response.extend_from_slice(&flags.to_be_bytes());
    response.extend_from_slice(&1_u16.to_be_bytes());
    response.extend_from_slice(&(u16::from(answer)).to_be_bytes());
    response.extend_from_slice(&0_u16.to_be_bytes());
    response.extend_from_slice(&0_u16.to_be_bytes());
    response.extend_from_slice(&packet[12..question_end]);
    if answer {
        response.extend_from_slice(&[0xc0, 0x0c]);
        response.extend_from_slice(&address_type.to_be_bytes());
        response.extend_from_slice(&1_u16.to_be_bytes());
        response.extend_from_slice(&30_u32.to_be_bytes());
        match config.address {
            IpAddr::V4(address) => {
                response.extend_from_slice(&4_u16.to_be_bytes());
                response.extend_from_slice(&address.octets());
            }
            IpAddr::V6(address) => {
                response.extend_from_slice(&16_u16.to_be_bytes());
                response.extend_from_slice(&address.octets());
            }
        }
    }
    Ok(response)
}

fn read_name(packet: &[u8], mut offset: usize) -> Result<(String, usize), String> {
    let mut labels = Vec::new();
    loop {
        let length = *packet
            .get(offset)
            .ok_or_else(|| "truncated DNS name".to_string())? as usize;
        offset += 1;
        if length == 0 {
            break;
        }
        if length > 63 || offset + length > packet.len() {
            return Err("invalid DNS name".into());
        }
        let label = std::str::from_utf8(&packet[offset..offset + length])
            .map_err(|_| "non-UTF-8 DNS name".to_string())?;
        labels.push(label.to_ascii_lowercase());
        offset += length;
    }
    Ok((labels.join("."), offset))
}

fn servfail(packet: &[u8]) -> Vec<u8> {
    let mut response = vec![0_u8; 12];
    if packet.len() >= 2 {
        response[0..2].copy_from_slice(&packet[0..2]);
    }
    response[2..4].copy_from_slice(&0x8002_u16.to_be_bytes());
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    fn query(name: &str, question_type: u16) -> Vec<u8> {
        let mut packet = vec![0x12, 0x34, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0];
        for label in name.split('.') {
            packet.push(label.len() as u8);
            packet.extend_from_slice(label.as_bytes());
        }
        packet.push(0);
        packet.extend_from_slice(&question_type.to_be_bytes());
        packet.extend_from_slice(&1_u16.to_be_bytes());
        packet
    }

    #[test]
    fn answers_apex_and_subdomains_with_the_device_address() {
        let config = Config {
            zone: "xps".into(),
            address: "100.64.0.1".parse().unwrap(),
            listen: "0.0.0.0".parse().unwrap(),
        };
        for name in ["xps", "ember-oak.xps"] {
            let response = response_for(&query(name, 1), &config).unwrap();
            assert_eq!(u16::from_be_bytes([response[6], response[7]]), 1);
            assert!(response.ends_with(&[100, 64, 0, 1]));
        }
    }

    #[test]
    fn refuses_names_outside_the_device_zone() {
        let config = Config {
            zone: "xps".into(),
            address: "100.64.0.1".parse().unwrap(),
            listen: "0.0.0.0".parse().unwrap(),
        };
        let response = response_for(&query("other", 1), &config).unwrap();
        assert_eq!(u16::from_be_bytes([response[2], response[3]]) & 0xf, 3);
        assert_eq!(u16::from_be_bytes([response[6], response[7]]), 0);
    }

    #[test]
    fn validates_service_arguments() {
        let config = parse_args(
            ["--zone", "mbp", "--address", "100.64.0.2"]
                .into_iter()
                .map(str::to_string),
        )
        .unwrap();
        assert_eq!(config.zone, "mbp");
        assert_eq!(config.address, "100.64.0.2".parse::<IpAddr>().unwrap());
        assert!(
            parse_args(
                ["--zone", "bad.zone", "--address", "100.64.0.2"]
                    .into_iter()
                    .map(str::to_string)
            )
            .is_err()
        );
    }
}

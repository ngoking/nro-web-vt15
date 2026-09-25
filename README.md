# NRO Web VT15 - Online-ready prototype

Ban nay da duoc chinh de deploy len cloud: bind `0.0.0.0`, dung bien moi truong `PORT`, ho tro HTTPS/WSS tu dong theo domain. Xem `DEPLOY-ONLINE.md`.

# NRO Web — Vũ trụ 15 prototype

Đây là prototype đầu tiên để kiểm tra **browser → WebSocket gateway → TCP → Vũ trụ 15**.

Đích được khóa cứng trong gateway:

- Host: `dragon15.teamobi.com`
- Port: `14445`
- Client version thử nghiệm: `2.4.6` (suy ra từ build `MOD_DP_246` được cung cấp)

## Đã làm

- WebSocket → TCP gateway, không phải open proxy.
- Handshake command `-27`.
- Đọc key server và phép XOR cumulative của client NRO.
- Framing packet mã hóa với read/write cursor riêng.
- `messageNotLogin(-29)` / subcommand `2` (`setClientType`).
- `messageNotLogin(-29)` / subcommand `0` (`login`).
- Web form để tự nhập tài khoản/mật khẩu; không dùng dữ liệu đăng nhập tìm thấy trong file game.
- Packet log để biết server có chấp nhận phiên web hay không.

## Chạy trên Windows

Cần Python 3.10+.

1. Giải nén thư mục này.
2. Chạy `run.bat`.
3. Mở `http://127.0.0.1:8765`.
4. Bấm **Kết nối VT15**.
5. Nếu hiện `Handshake OK`, nhập tài khoản/mật khẩu rồi bấm **Đăng nhập**.

Nếu máy chủ không truy cập được từ mạng của bạn, log gateway sẽ cho biết lỗi DNS/TCP.

## Trạng thái hiện tại

Đây **chưa phải client chơi hoàn chỉnh**. Sau login còn phải port các phần sau từ client:

1. parser các packet dữ liệu/version và `clientOk`;
2. map/tile/background;
3. character/mob/NPC/item;
4. movement/combat/skill;
5. inventory/panel/menu/dialog;
6. input PC/mobile;
7. asset loader từ bộ dữ liệu game.

Phần khó nhất trước mắt là xác minh handshake + login của build 2.4.6 trên server live. Khi bước này chạy, renderer có thể được phát triển độc lập mà không phải đoán transport/protocol nữa.

## Lưu ý

Không đưa file client gốc hoặc thư mục `Data` lên repo công khai: bản được cung cấp có dữ liệu tài khoản/cache cục bộ. Project này không sao chép các giá trị đó.

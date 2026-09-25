# Deploy online - NRO Web VT15

## Render (de nhat)

1. Tao 1 repo GitHub moi va upload toan bo file trong thu muc nay.
2. Vao Render -> New -> Blueprint.
3. Ket noi repo GitHub vua tao.
4. Render se doc `render.yaml`. Bam Apply/Deploy.
5. Cho deploy thanh cong, mo URL dang:
   `https://nro-web-vt15-xxxx.onrender.com`
6. Bam **Ket noi VT15** tren trang.

WebSocket tu dong dung `wss://<domain>/ws`, khong can sua URL.

### Luu y Render Free
- Free web service co the sleep sau 15 phut khong co HTTP/WebSocket traffic.
- Lan mo dau sau khi sleep co the mat khoang vai chuc giay den ~1 phut de khoi dong lai.
- Khi dang co WebSocket traffic, Render hien tai giu service active.

## Cau hinh cloud bat buoc

Gateway da duoc sua de bind:
- host: `0.0.0.0`
- port: bien moi truong `PORT` cua hosting

Dich dich duoc khoa cung:
- `dragon15.teamobi.com:14445`

Khong phai open proxy.

## Test

Mo:
- `/health` -> phai thay JSON `ok: true`
- trang chu -> bam **Ket noi VT15**

Neu gateway khong ket noi duoc dich, xem log deploy de tim loi DNS/TCP/timeout.

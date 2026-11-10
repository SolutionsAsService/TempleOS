; gamec dist MBR: boot the first partition (or the active one) with no menu.
bits 16
org 0x600
start:
  cli
  xor ax,ax
  mov ss,ax
  mov sp,0x7C00
  mov ds,ax
  mov es,ax
  mov si,0x7C00
  mov di,0x600
  mov cx,256
  rep movsw
  jmp 0:reloc
reloc:
  sti
  mov [drive],dl
  mov si,0x7BE
  mov cx,4
.find:
  test byte [si],0x80
  jnz .found
  add si,16
  loop .find
  mov si,0x7BE
.found:
  mov eax,[si+8]
  mov [dap_lba],eax
  push si
  mov si,dap
  mov ah,0x42
  mov dl,[drive]
  int 0x13
  pop si
  jc fail
  mov dl,[drive]
  jmp 0:0x7C00
fail:
  mov si,msg
.p:
  lodsb
  or al,al
  jz .h
  mov ah,0x0e
  int 0x10
  jmp .p
.h:
  hlt
  jmp .h
drive: db 0
dap: db 16,0
     dw 1
     dw 0x7C00,0
dap_lba: dd 0,0
msg: db "gamec MBR: cannot read the boot partition",0
times 440-($-$$) db 0

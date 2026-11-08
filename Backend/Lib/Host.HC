#help_index "Games/Backend"
//HOST LINK -- lets a running game talk to the machine that hosts the VM.
//QEMU option "-serial file:serial.log" turns every byte sent to COM1 into a line in that file.
//UNVERIFIED: written from the 16550 UART register map, not yet run in TempleOS.

#define HOST_COM1 0x3F8

U0 HostPutChar(U8 ch)
{
  I64 spin=100000;
  while (!(InU8(HOST_COM1+5)&0x20) && spin) //wait for the transmit register to be empty
    spin--;
  OutU8(HOST_COM1,ch);
}

U0 HostLog(U8 *s)
{//One line to the host. Safe to call with no UART present (it gives up after a bounded wait).
  while (*s)
    HostPutChar(*s++);
  HostPutChar('\n');
}

U0 HostLogI(U8 *tag,I64 v)
{//"tag=value" for test results the host can grep.
  U8 buf[48];
  StrPrint(buf,"%s=%d",tag,v);
  HostLog(buf);
}

U0 HostDone(I64 fails)
{//The last line a test run prints.
  if (fails)
    HostLogI("BACKEND_FAIL",fails);
  else
    HostLog("BACKEND_OK");
}

#help_index ""

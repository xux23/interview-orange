Add-Type @'
using System;
public class T1 { public static int X() { return 1; } }
'@
[T1]::X()

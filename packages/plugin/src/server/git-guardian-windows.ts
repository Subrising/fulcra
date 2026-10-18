// A retained Job Object owns Git descendants even after Git itself exits.
export const WINDOWS_GIT_GUARDIAN = String.raw`
using System;
using System.Text;
using System.Threading;
using System.Diagnostics;
using System.Runtime.InteropServices;
public class FulcraGitGuardian {
 [StructLayout(LayoutKind.Sequential)] struct BasicLimit { public long ProcessTime, JobTime; public uint Flags; public UIntPtr MinWorkingSet, MaxWorkingSet; public uint ActiveLimit; public UIntPtr Affinity; public uint Priority, Scheduling; }
 [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
 [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit { public BasicLimit Basic; public IoCounters Io; public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory; }
 [StructLayout(LayoutKind.Sequential)] struct Accounting { public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime; public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses; }
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Startup { public uint Size; public string Reserved, Desktop, Title; public uint X,Y,Width,Height,XChars,YChars,Fill,Flags; public ushort Show,ReservedSize; public IntPtr ReservedData,Input,Output,Error; }
 [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process,Thread; public uint Pid,Tid; }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int info,ref ExtendedLimit value,uint size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int info,ref Accounting value,uint size,IntPtr returned);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string application,StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,uint flags,IntPtr environment,string cwd,ref Startup startup,out ProcessInfo info);
 [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
 [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
 [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
 [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
 [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process,uint code);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 static string Quote(string text) { var b=new StringBuilder("\""); int slashes=0; foreach(char c in text){if(c=='\\'){slashes++;continue;} if(c=='"'){b.Append('\\',slashes*2+1);b.Append(c);}else{b.Append('\\',slashes);b.Append(c);}slashes=0;}b.Append('\\',slashes*2);b.Append('"');return b.ToString(); }
 static Exception Failure(string action){return new Exception(action+" failed: "+Marshal.GetLastWin32Error());}
 public static int Main(string[] args) {
  IntPtr job=IntPtr.Zero; ProcessInfo info=new ProcessInfo();
  uint deadline; if(!UInt32.TryParse(Environment.GetEnvironmentVariable("FULCRA_GIT_TIMEOUT_MS"),out deadline)||deadline<1||deadline>120000)deadline=30000;
  var clock=Stopwatch.StartNew();
  try {
   job=CreateJobObject(IntPtr.Zero,null);if(job==IntPtr.Zero)throw Failure("CreateJobObject");
   var limit=new ExtendedLimit();limit.Basic.Flags=0x2000;
   if(!SetInformationJobObject(job,9,ref limit,(uint)Marshal.SizeOf(limit)))throw Failure("SetInformationJobObject");
   var startup=new Startup();startup.Size=(uint)Marshal.SizeOf(startup);startup.Flags=0x101;startup.Input=GetStdHandle(-10);startup.Output=GetStdHandle(-11);startup.Error=GetStdHandle(-12);
   var command=new StringBuilder(Quote("git.exe"));foreach(var arg in args)command.Append(" "+Quote(arg));
   if(!CreateProcess(null,command,IntPtr.Zero,IntPtr.Zero,true,0x08000004,IntPtr.Zero,Environment.CurrentDirectory,ref startup,out info))throw Failure("CreateProcess");
   if(!AssignProcessToJobObject(job,info.Process)){TerminateProcess(info.Process,1);throw Failure("AssignProcessToJobObject");}
   if(ResumeThread(info.Thread)==0xffffffff)throw Failure("ResumeThread");
   if(WaitForSingleObject(info.Process,deadline)==258){Console.Error.WriteLine("Git command timed out");return 1;}uint code;if(!GetExitCodeProcess(info.Process,out code))throw Failure("GetExitCodeProcess");
   var account=new Accounting();
   do {if(!QueryInformationJobObject(job,1,ref account,(uint)Marshal.SizeOf(account),IntPtr.Zero))throw Failure("QueryInformationJobObject");if(clock.ElapsedMilliseconds>=deadline){Console.Error.WriteLine("Git command timed out");return 1;}if(account.ActiveProcesses>0)Thread.Sleep(20);}while(account.ActiveProcesses>0);
   return unchecked((int)code);
  }catch(Exception error){Console.Error.WriteLine("Fulcra git guardian: "+error.Message);return 1;}
  finally{if(info.Thread!=IntPtr.Zero)CloseHandle(info.Thread);if(info.Process!=IntPtr.Zero)CloseHandle(info.Process);if(job!=IntPtr.Zero)CloseHandle(job);}
 }
}
`;

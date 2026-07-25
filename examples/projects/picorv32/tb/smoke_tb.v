// Self-checking smoke test for the real PicoRV32 core in ../rtl/picorv32.v
// (see ../rtl/NOTICE.md for its origin). Original to this repo -- not
// upstream picorv32's own testbench.
//
// Preloads a tiny hand-assembled RV32I program (no RISC-V toolchain
// needed) that counts x1 from 0 to 10 in a loop, then stores the result
// to a memory-mapped address the testbench watches. This is real RV32I
// machine code executing on the real core: addi/bne branch back through
// the loop nine times before falling through to the store.
//
//   0: addi x1, x0, 0        x1 = 0 (counter)
//   4: addi x2, x0, 10       x2 = 10 (limit)
//   8: addi x3, x0, 1024     x3 = result address
//  12: loop: addi x1, x1, 1  x1++
//  16: bne  x1, x2, loop
//  20: sw   x1, 0(x3)        memory[1024] = x1 (== 10)
//  24: halt: jal  x0, halt   spin (keeps the core busy until $finish)
`timescale 1 ns / 1 ps

module smoke_tb;
	reg clk = 1;
	reg resetn = 0;
	wire trap;

	always #5 clk = ~clk;

	wire mem_valid;
	wire mem_instr;
	reg mem_ready;
	wire [31:0] mem_addr;
	wire [31:0] mem_wdata;
	wire [3:0] mem_wstrb;
	reg [31:0] mem_rdata;

	picorv32 uut (
		.clk       (clk      ),
		.resetn    (resetn   ),
		.trap      (trap     ),
		.mem_valid (mem_valid),
		.mem_instr (mem_instr),
		.mem_ready (mem_ready),
		.mem_addr  (mem_addr ),
		.mem_wdata (mem_wdata),
		.mem_wstrb (mem_wstrb),
		.mem_rdata (mem_rdata)
	);

	reg [31:0] memory [0:255];
	reg [31:0] result;
	reg result_valid = 0;

	initial begin
		memory[0] = 32'h 00000093; // addi x1, x0, 0
		memory[1] = 32'h 00a00113; // addi x2, x0, 10
		memory[2] = 32'h 40000193; // addi x3, x0, 1024
		memory[3] = 32'h 00108093; // loop: addi x1, x1, 1
		memory[4] = 32'h fe209ee3; // bne x1, x2, loop
		memory[5] = 32'h 0011a023; // sw x1, 0(x3)
		memory[6] = 32'h 0000006f; // halt: jal x0, halt
	end

	// Address 1024 is memory-mapped: a write there is the program's
	// "done" signal, not backed by the memory[] array like addresses
	// below it -- watched below instead of read back.
	always @(posedge clk) begin
		mem_ready <= 0;
		if (mem_valid && !mem_ready) begin
			if (mem_addr < 1024) begin
				mem_ready <= 1;
				mem_rdata <= memory[mem_addr >> 2];
			end else if (mem_addr == 1024) begin
				mem_ready <= 1;
				mem_rdata <= 32'h 0;
				if (mem_wstrb[0]) begin
					result <= mem_wdata;
					result_valid <= 1;
				end
			end
		end
	end

	initial begin
		repeat (100) @(posedge clk);
		resetn <= 1;
		repeat (2000) @(posedge clk);
		if (result_valid && result == 10)
			$display("TEST PASSED: RV32I loop wrote result=%0d to 0x400", result);
		else if (result_valid)
			$display("TEST FAILED: RV32I loop wrote wrong result=%0d (expected 10)", result);
		else
			$display("TEST FAILED: RV32I loop never wrote a result within the cycle budget");
		$finish;
	end
endmodule

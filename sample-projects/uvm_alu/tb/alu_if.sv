// Interface bundling the ALU DUT pins for the UVM testbench.
interface alu_if #(
    parameter int W = 32
) (
    input logic clk
);
    logic         rst_n;
    logic         in_valid;
    logic [3:0]   op;
    logic [W-1:0] a;
    logic [W-1:0] b;
    logic         bug_en;
    logic         out_valid;
    logic [W-1:0] result;
endinterface
